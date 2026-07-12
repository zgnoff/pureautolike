import assert from 'node:assert/strict';
import {createHmac, randomBytes, webcrypto} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import test from 'node:test';

import {loadConfig} from '../src/config.js';
import {decryptSessionEnvelope} from '../src/crypto.js';
import {
  canonicalRequest,
  createControlClient,
  signRequest
} from '../src/control-client.js';
import {ConnectorManager} from '../src/connector-manager.js';
import {runGateway} from '../src/main.js';

const encoder = new TextEncoder();
const SEEDED_BEARER = 'fixture-auth-value-gateway-foundation';
const SEEDED_AGENT = 'gateway-foundation-seeded-agent';
const KEY_ID = 'gateway-key-2026-07';
const ACCOUNT_ID = 'account-fixture-42';

function base64Url(bytes) {
  return Buffer.from(bytes).toString('base64url');
}

async function generatedPrivateJwk() {
  const keys = await webcrypto.subtle.generateKey(
    {name: 'ECDH', namedCurve: 'P-256'},
    true,
    ['deriveBits']
  );
  return webcrypto.subtle.exportKey('jwk', keys.privateKey);
}

function configEnv(privateJwk) {
  return {
    CONTROL_PLANE_URL: 'https://control.example.test/',
    GATEWAY_ID: 'gateway-1',
    GATEWAY_HMAC_SECRET: 'a'.repeat(32),
    GATEWAY_PRIVATE_JWK: JSON.stringify(privateJwk),
    GATEWAY_KEY_ID: KEY_ID
  };
}

async function envelopeFixture({accountBinding = ACCOUNT_ID, keyId = KEY_ID, keyPair} = {}) {
  const gatewayKeys = keyPair || await webcrypto.subtle.generateKey(
    {name: 'ECDH', namedCurve: 'P-256'},
    true,
    ['deriveBits']
  );
  const publicJwk = await webcrypto.subtle.exportKey('jwk', gatewayKeys.publicKey);
  const privateJwk = await webcrypto.subtle.exportKey('jwk', gatewayKeys.privateKey);
  const ephemeralKeys = await webcrypto.subtle.generateKey(
    {name: 'ECDH', namedCurve: 'P-256'},
    true,
    ['deriveBits']
  );
  const sharedSecret = await webcrypto.subtle.deriveBits(
    {name: 'ECDH', public: await webcrypto.subtle.importKey('jwk', publicJwk, {name: 'ECDH', namedCurve: 'P-256'}, false, [])},
    ephemeralKeys.privateKey,
    256
  );
  const salt = randomBytes(32);
  const iv = randomBytes(12);
  const hkdfKey = await webcrypto.subtle.importKey('raw', sharedSecret, 'HKDF', false, ['deriveKey']);
  const aesKey = await webcrypto.subtle.deriveKey(
    {name: 'HKDF', hash: 'SHA-256', salt, info: encoder.encode('pureautolike/cloud-session-envelope/v1')},
    hkdfKey,
    {name: 'AES-GCM', length: 256},
    false,
    ['encrypt']
  );
  const envelope = {
    version: 1,
    keyId,
    accountBinding,
    createdAt: 1783861200000
  };
  const aad = encoder.encode(JSON.stringify(envelope));
  const plaintext = encoder.encode(JSON.stringify({bearer: SEEDED_BEARER, xJsUserAgent: SEEDED_AGENT}));
  const ciphertext = await webcrypto.subtle.encrypt(
    {name: 'AES-GCM', iv, additionalData: aad, tagLength: 128},
    aesKey,
    plaintext
  );
  const ephemeralPublicKey = await webcrypto.subtle.exportKey('jwk', ephemeralKeys.publicKey);
  return {
    envelope: {
      ...envelope,
      ephemeralPublicKey: {
        kty: ephemeralPublicKey.kty,
        crv: ephemeralPublicKey.crv,
        x: ephemeralPublicKey.x,
        y: ephemeralPublicKey.y
      },
      salt: base64Url(salt),
      iv: base64Url(iv),
      ciphertext: base64Url(ciphertext)
    },
    privateJwk
  };
}

test('loads exactly the required gateway secrets and a generated P-256 private JWK', async () => {
  const privateJwk = await generatedPrivateJwk();
  const env = configEnv(privateJwk);
  const config = loadConfig(env);
  assert.equal(config.controlPlaneUrl, 'https://control.example.test');
  assert.equal(config.gatewayId, 'gateway-1');
  assert.deepEqual(config.privateJwk, privateJwk);
  assert.throws(
    () => loadConfig({...env, GATEWAY_PRIVATE_JWK: SEEDED_BEARER}),
    error => error.code === 'INVALID_CONFIG' && !String(error).includes(SEEDED_BEARER)
  );
  for (const name of Object.keys(env)) {
    assert.throws(() => loadConfig({...env, [name]: ''}), {code: 'INVALID_CONFIG'});
  }
});

test('rejects malformed, public, wrong-curve, noncanonical, and incompatible private JWKs safely', async () => {
  const valid = await generatedPrivateJwk();
  const publicOnly = {...valid};
  delete publicOnly.d;
  const finalAlphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  const finalIndex = finalAlphabet.indexOf(valid.x.at(-1));
  const noncanonicalX = valid.x.slice(0, -1) + finalAlphabet[(finalIndex & 0x30) | 1];
  const invalidValues = [
    [],
    publicOnly,
    {...valid, crv: 'P-384'},
    {...valid, x: noncanonicalX},
    {...valid, y: base64Url(randomBytes(31))},
    {...valid, d: SEEDED_BEARER},
    {...valid, alg: 'ES256'},
    {...valid, ext: false},
    {...valid, key_ops: ['sign']}
  ];
  for (const invalid of invalidValues) {
    assert.throws(
      () => loadConfig(configEnv(invalid)),
      error => error.code === 'INVALID_CONFIG' &&
        !String(error).includes(SEEDED_BEARER) &&
        !String(error).includes(valid.d)
    );
  }
});

test('rejects canonical off-curve coordinates and private scalars that do not match the public point', async () => {
  const valid = await generatedPrivateJwk();
  const unrelated = await generatedPrivateJwk();
  const mutateCanonical = value => {
    const bytes = Buffer.from(value, 'base64url');
    bytes[0] ^= 0x01;
    return bytes.toString('base64url');
  };
  const invalidValues = [
    {...valid, x: mutateCanonical(valid.x)},
    {...valid, y: mutateCanonical(valid.y)},
    {...valid, d: unrelated.d}
  ];
  for (const invalid of invalidValues) {
    assert.throws(
      () => loadConfig(configEnv(invalid)),
      error => error.code === 'INVALID_CONFIG' &&
        !String(error).includes(valid.d) &&
        !String(error).includes(unrelated.d)
    );
  }
  assert.deepEqual(loadConfig(configEnv(valid)).privateJwk, valid);
});

test('decrypts the browser Web Crypto envelope with the gateway private JWK', async () => {
  const fixture = await envelopeFixture();
  const session = await decryptSessionEnvelope(fixture.envelope, {
    privateJwk: fixture.privateJwk,
    keyId: KEY_ID,
    accountBinding: ACCOUNT_ID
  });
  assert.deepEqual(session, {bearer: SEEDED_BEARER, xJsUserAgent: SEEDED_AGENT});
});

test('rejects AAD tampering, wrong key IDs, and wrong account bindings with credential-safe errors', async () => {
  const fixture = await envelopeFixture();
  const cases = [
    [{...fixture.envelope, createdAt: fixture.envelope.createdAt + 1}, KEY_ID, ACCOUNT_ID, 'DECRYPT_FAILED'],
    [fixture.envelope, 'wrong-key', ACCOUNT_ID, 'KEY_MISMATCH'],
    [fixture.envelope, KEY_ID, 'wrong-account', 'ACCOUNT_MISMATCH']
  ];
  for (const [envelope, keyId, accountBinding, code] of cases) {
    await assert.rejects(
      decryptSessionEnvelope(envelope, {privateJwk: fixture.privateJwk, keyId, accountBinding}),
      error => error.code === code &&
        !String(error).includes(SEEDED_BEARER) &&
        !String(error).includes(SEEDED_AGENT) &&
        !String(error).includes(fixture.privateJwk.d)
    );
  }
});

test('signs the Task 7 canonical method, path, timestamp, nonce, and body digest', () => {
  const secret = 'canonical-secret-value';
  const input = {
    method: 'POST',
    path: '/internal/gateway/leases',
    timestamp: '1783861200',
    nonce: 'nonce-fixture',
    body: '{"gateway_id":"gateway-1","limit":20}'
  };
  const canonical = canonicalRequest(input);
  assert.equal(
    canonical,
    'POST\n/internal/gateway/leases\n1783861200\nnonce-fixture\n656e2bbf5c3fb57c7128301140023bea21f8daf8608bca72cb911a5cc72c5046'
  );
  assert.equal(signRequest(secret, input), createHmac('sha256', secret).update(canonical).digest('hex'));
});

test('uses a unique nonce for every signed request', async () => {
  const requests = [];
  const client = createControlClient({
    controlPlaneUrl: 'https://control.example.test',
    gatewayId: 'gateway-1',
    hmacSecret: 'n'.repeat(32),
    fetchImpl: async (url, options) => {
      requests.push({url, options});
      return new Response('{"leases":[]}', {status: 200, headers: {'content-type': 'application/json'}});
    }
  });
  await client.pollLeases();
  await client.pollLeases();
  assert.notEqual(requests[0].options.headers['x-gateway-nonce'], requests[1].options.headers['x-gateway-nonce']);
});

test('rejects malformed control client configuration without echoing supplied values', () => {
  assert.throws(
    () => createControlClient({
      controlPlaneUrl: SEEDED_BEARER,
      gatewayId: 'gateway-1',
      hmacSecret: 's'.repeat(32)
    }),
    error => error.code === 'CONTROL_INVALID_CONFIG' && !String(error).includes(SEEDED_BEARER)
  );
});

test('polls bounded leases and sends only redacted heartbeat connector fields', async () => {
  const requests = [];
  const client = createControlClient({
    controlPlaneUrl: 'https://control.example.test',
    gatewayId: 'gateway-1',
    hmacSecret: 'h'.repeat(32),
    fetchImpl: async (url, options) => {
      requests.push({url, options, body: JSON.parse(options.body)});
      const payload = url.endsWith('/leases') ? {leases: [{account_id: ACCOUNT_ID, lease_token: 'opaque'}]} : {ok: true};
      return new Response(JSON.stringify(payload), {status: 200, headers: {'content-type': 'application/json'}});
    }
  });
  const leases = await client.pollLeases({limit: 99});
  assert.equal(leases.length, 1);
  assert.equal(requests[0].body.limit, 20);
  await client.heartbeat([{
    account_id: ACCOUNT_ID,
    state: 'compatibility_required',
    bearer: SEEDED_BEARER,
    error: SEEDED_AGENT,
    envelope: {ciphertext: 'must-not-leave-manager'}
  }]);
  assert.deepEqual(requests[1].body, {
    gateway_id: 'gateway-1',
    connectors: [{account_id: ACCOUNT_ID, state: 'compatibility_required'}]
  });
  assert(!requests[1].options.body.includes(SEEDED_BEARER));
  assert(!requests[1].options.body.includes(SEEDED_AGENT));
});

test('bounds control-plane responses and timeouts without echoing response bodies', async () => {
  const oversized = createControlClient({
    controlPlaneUrl: 'https://control.example.test',
    gatewayId: 'gateway-1',
    hmacSecret: 'b'.repeat(32),
    maxResponseBytes: 32,
    fetchImpl: async () => new Response(JSON.stringify({leases: ['x'.repeat(64)]}), {status: 200})
  });
  await assert.rejects(oversized.pollLeases(), {code: 'CONTROL_RESPONSE_TOO_LARGE'});

  const timeout = createControlClient({
    controlPlaneUrl: 'https://control.example.test',
    gatewayId: 'gateway-1',
    hmacSecret: 't'.repeat(32),
    timeoutMs: 10,
    fetchImpl: async (_url, {signal}) => new Promise((resolve, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason), {once: true});
    })
  });
  await assert.rejects(timeout.pollLeases(), {code: 'CONTROL_TIMEOUT'});
});

test('cancels response bodies on declared oversize and HTTP error paths', async () => {
  let oversizeCancelled = 0;
  const oversizeBody = new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode('{"leases":[]}'));
    },
    cancel() {
      oversizeCancelled += 1;
    }
  });
  const oversized = createControlClient({
    controlPlaneUrl: 'https://control.example.test',
    gatewayId: 'gateway-1',
    hmacSecret: 'c'.repeat(32),
    maxResponseBytes: 32,
    fetchImpl: async () => new Response(oversizeBody, {
      status: 200,
      headers: {'content-length': '1024'}
    })
  });
  await assert.rejects(oversized.pollLeases(), {code: 'CONTROL_RESPONSE_TOO_LARGE'});
  assert.equal(oversizeCancelled, 1, 'declared oversized response body must be cancelled');

  let httpErrorCancelled = 0;
  const errorBody = new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(SEEDED_BEARER));
    },
    cancel() {
      httpErrorCancelled += 1;
    }
  });
  const unavailable = createControlClient({
    controlPlaneUrl: 'https://control.example.test',
    gatewayId: 'gateway-1',
    hmacSecret: 'e'.repeat(32),
    fetchImpl: async () => new Response(errorBody, {status: 503})
  });
  await assert.rejects(unavailable.pollLeases(), {code: 'CONTROL_HTTP_ERROR'});
  assert.equal(httpErrorCancelled, 1, 'HTTP error response body must be cancelled');
});

test('repeated gateway cycles do not retain abort listeners between delays', async () => {
  const listeners = new Set();
  const signal = {
    aborted: false,
    addEventListener(type, listener) {
      if (type === 'abort') listeners.add(listener);
    },
    removeEventListener(type, listener) {
      if (type === 'abort') listeners.delete(listener);
    }
  };
  let cycles = 0;
  const client = {
    async pollLeases() {
      return [];
    },
    async heartbeat() {
      cycles += 1;
      if (cycles === 25) signal.aborted = true;
      return {ok: true};
    }
  };
  const manager = {async reconcile() { return []; }};
  await runGateway({config: {}, client, manager, signal, pollIntervalMs: 1});
  assert.equal(cycles, 25);
  assert.equal(listeners.size, 0, 'resolved delays must remove their abort listeners');
});

test('reconciles only foundation connector states and never exposes decrypted credentials', async () => {
  const transitions = [];
  const fixture = await envelopeFixture();
  const manager = new ConnectorManager({
    privateJwk: fixture.privateJwk,
    keyId: KEY_ID,
    onTransition: transition => transitions.push(transition)
  });
  const snapshots = await manager.reconcile([{
    account_id: ACCOUNT_ID,
    envelope: fixture.envelope
  }]);
  assert.deepEqual(transitions.map(item => item.state), [
    'decrypting',
    'authenticating',
    'compatibility_required'
  ]);
  assert.deepEqual(snapshots, [{account_id: ACCOUNT_ID, state: 'compatibility_required'}]);
  assert(!JSON.stringify({transitions, snapshots}).includes(SEEDED_BEARER));

  assert.deepEqual(await manager.reconcile([]), [{account_id: ACCOUNT_ID, state: 'disabled'}]);
  assert.deepEqual(
    await manager.reconcile([{account_id: ACCOUNT_ID, revoked: true}]),
    [{account_id: ACCOUNT_ID, state: 'revoked'}]
  );
});

test('turns decrypt failures into a stable credential-safe compatibility state', async () => {
  const fixture = await envelopeFixture();
  const manager = new ConnectorManager({privateJwk: fixture.privateJwk, keyId: KEY_ID});
  const snapshots = await manager.reconcile([{
    account_id: ACCOUNT_ID,
    envelope: {...fixture.envelope, ciphertext: base64Url(encoder.encode(SEEDED_BEARER))}
  }]);
  assert.deepEqual(snapshots, [{account_id: ACCOUNT_ID, state: 'compatibility_required'}]);
  assert(!JSON.stringify(snapshots).includes(SEEDED_BEARER));
});

test('ships a hardened unprivileged systemd service with one writable spool', async () => {
  const service = await readFile(new URL('../deploy/pureautolike-gateway.service', import.meta.url), 'utf8');
  for (const directive of [
    'User=pureautolike-gateway',
    'NoNewPrivileges=true',
    'PrivateTmp=true',
    'ProtectSystem=strict',
    'ProtectHome=true',
    'MemoryMax=1G',
    'Restart=on-failure',
    'RestartSec=5s',
    'ReadWritePaths=/var/lib/pureautolike-gateway/spool'
  ]) {
    assert(service.includes(directive), `service must include ${directive}`);
  }
  assert.equal((service.match(/^ReadWritePaths=/gm) || []).length, 1);
});
