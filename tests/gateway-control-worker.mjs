import assert from 'node:assert/strict';
import {createHash, createHmac} from 'node:crypto';

import worker from '../backend/license-worker/src/worker.js';
import {createGatewayControl} from '../backend/license-worker/src/gateway-control.js';

const NOW = new Date('2026-07-12T12:00:00.000Z');
const SECRET = 'gateway-control-secret-value-32-bytes';
const SECRET_TWO = 'second-gateway-secret-value-32-bytes';
const encoder = new TextEncoder();

function signature({method = 'POST', path, timestamp, nonce, body, secret = SECRET}) {
  const digest = createHash('sha256').update(body).digest('hex');
  return createHmac('sha256', secret)
    .update([method.toUpperCase(), path, String(timestamp), nonce, digest].join('\n'))
    .digest('hex');
}

function signedRequest(path, payload, overrides = {}) {
  const body = overrides.body ?? JSON.stringify(payload);
  const timestamp = String(overrides.timestamp ?? Math.floor(NOW.getTime() / 1000));
  const nonce = overrides.nonce ?? `gateway-nonce-${signedRequest.sequence++}`;
  const gatewayId = overrides.gatewayId ?? 'gateway-1';
  const signedPath = overrides.signedPath ?? path;
  return new Request(`https://worker.example${path}`, {
    method: overrides.method ?? 'POST',
    headers: {
      'content-type': 'application/json',
      'x-gateway-id': gatewayId,
      'x-gateway-timestamp': timestamp,
      'x-gateway-nonce': nonce,
      'x-gateway-signature': overrides.signature ?? signature({
        method: overrides.method ?? 'POST',
        path: signedPath,
        timestamp,
        nonce,
        body,
        secret: overrides.secret
      })
    },
    body
  });
}
signedRequest.sequence = 1;

function createGatewayDb() {
  const calls = [];
  const nonces = new Set();
  const sessions = [
    {
      id: 'session-active', account_id: 'account-active', active_device_id: 'device-active',
      envelope_ciphertext: JSON.stringify({version: 1, keyId: 'key-1', accountBinding: 'account-active', ciphertext: 'ciphertext-active'}),
      status: 'pending', account_status: 'active', device_status: 'active'
    },
    {
      id: 'session-inactive-account', account_id: 'account-inactive', active_device_id: 'device-inactive-account',
      envelope_ciphertext: JSON.stringify({ciphertext: 'must-not-leak-account'}),
      status: 'pending', account_status: 'suspended', device_status: 'active'
    },
    {
      id: 'session-inactive-device', account_id: 'account-inactive-device', active_device_id: 'device-inactive',
      envelope_ciphertext: JSON.stringify({ciphertext: 'must-not-leak-device'}),
      status: 'pending', account_status: 'active', device_status: 'revoked'
    }
  ];
  const leases = [];

  return {
    calls,
    sessions,
    leases,
    prepare(sql) {
      let params = [];
      const statement = {
        bind(...values) { params = values; return statement; },
        async run() {
          calls.push({sql, params, method: 'run'});
          if (sql.includes('DELETE FROM bridge_gateway_nonces')) return {success: true, meta: {changes: 0}};
          if (sql.includes('INSERT INTO bridge_gateway_nonces')) {
            const replayKey = `${params[0]}:${params[1]}`;
            if (nonces.has(replayKey)) return {success: true, meta: {changes: 0}};
            nonces.add(replayKey);
            return {success: true, meta: {changes: 1}};
          }
          if (sql.includes('INSERT INTO bridge_gateway_leases')) {
            const [id, accountId, deviceId, gatewayId, tokenHash, nowIso, expiresAt] = params;
            const held = leases.some(lease => lease.account_id === accountId && !lease.released_at && Date.parse(lease.expires_at) > Date.parse(nowIso));
            const session = sessions.find(item => item.account_id === accountId && item.active_device_id === deviceId);
            if (held || session?.account_status !== 'active' || session?.device_status !== 'active' || !['pending', 'active'].includes(session?.status)) {
              return {success: true, meta: {changes: 0}};
            }
            leases.push({
              id, account_id: accountId, device_id: deviceId, gateway_id: gatewayId,
              lease_token_hash: tokenHash, connector_state: 'disabled', heartbeat_at: null,
              expires_at: expiresAt, released_at: null
            });
            return {success: true, meta: {changes: 1}};
          }
          if (sql.includes('UPDATE bridge_gateway_leases') && sql.includes('SET released_at')) {
            const lease = leases.find(item => item.id === params[1]);
            if (lease) lease.released_at = NOW.toISOString();
            return {success: true, meta: {changes: lease ? 1 : 0}};
          }
          if (sql.includes('UPDATE bridge_gateway_leases') && sql.includes('connector_state')) {
            const [state, heartbeatAt, accountId, gatewayId, nowIso] = params;
            const lease = leases.find(item => item.account_id === accountId && item.gateway_id === gatewayId && !item.released_at && Date.parse(item.expires_at) > Date.parse(nowIso));
            if (!lease) return {success: true, meta: {changes: 0}};
            lease.connector_state = state;
            lease.heartbeat_at = heartbeatAt;
            return {success: true, meta: {changes: 1}};
          }
          if (sql.includes('UPDATE bridge_cloud_sessions')) {
            const [state, , accountId, gatewayId, nowIso] = params;
            const owned = leases.some(lease => lease.account_id === accountId && lease.gateway_id === gatewayId && !lease.released_at && Date.parse(lease.expires_at) > Date.parse(nowIso));
            const session = sessions.find(item => item.account_id === accountId);
            if (!owned || !session) return {success: true, meta: {changes: 0}};
            session.status = state;
            return {success: true, meta: {changes: 1}};
          }
          return {success: true, meta: {changes: 0}};
        },
        async all() {
          calls.push({sql, params, method: 'all'});
          if (sql.includes('FROM bridge_cloud_sessions s')) {
            const limit = params.at(-1);
            return {results: sessions.filter(item => item.account_status === 'active' && item.device_status === 'active' && ['pending', 'active'].includes(item.status)).slice(0, limit)};
          }
          return {results: []};
        },
        async first() {
          calls.push({sql, params, method: 'first'});
          if (sql.includes('FROM bridge_gateway_leases l')) {
            const lease = leases.find(item => item.id === params[0]);
            const session = sessions.find(item => item.account_id === lease?.account_id);
            return lease && session ? {...session, lease_expires_at: lease.expires_at} : null;
          }
          return null;
        }
      };
      return statement;
    }
  };
}

const envFor = db => ({
  DB: db,
  GATEWAY_HMAC_SECRETS: JSON.stringify({'gateway-1': SECRET, 'gateway-2': SECRET_TWO})
});
const control = createGatewayControl({
  now: () => new Date(NOW),
  randomUUID: (() => { let value = 0; return () => `00000000-0000-4000-8000-${String(++value).padStart(12, '0')}`; })()
});

async function call(request, db = createGatewayDb()) {
  const response = await control.handle(request, envFor(db));
  return {response, body: await response.json(), db};
}

{
  const db = createGatewayDb();
  const {response, body} = await call(signedRequest('/internal/gateway/leases?region=one', {gateway_id: 'gateway-1', limit: 20}), db);
  assert.equal(response.status, 200, 'valid canonical signature including query must pass');
  assert.equal(body.leases.length, 1, 'inactive account and device sessions must be omitted');
  assert.equal(body.leases[0].account_id, 'account-active');
  assert.equal(body.leases[0].envelope.ciphertext, 'ciphertext-active', 'ciphertext must be returned on the signed internal lease route');
  assert(!JSON.stringify(body).includes('must-not-leak'), 'inactive ciphertext must never be returned');
  assert(db.calls.some(call => call.sql.includes('NOT EXISTS') && call.sql.includes('bridge_gateway_leases')), 'lease acquisition must be an atomic conditional insert');
}

for (const offset of [-31, 31]) {
  const result = await call(signedRequest('/internal/gateway/leases', {gateway_id: 'gateway-1', limit: 20}, {
    timestamp: Math.floor(NOW.getTime() / 1000) + offset
  }));
  assert.equal(result.response.status, 401, 'timestamps outside ±30 seconds must fail');
  assert.equal(result.body.code, 'GATEWAY_UNAUTHORIZED');
}
for (const offset of [-30, 30]) {
  const result = await call(signedRequest('/internal/gateway/leases', {gateway_id: 'gateway-1', limit: 20}, {
    timestamp: Math.floor(NOW.getTime() / 1000) + offset
  }));
  assert.equal(result.response.status, 200, 'timestamps on the ±30 second boundary must pass');
}

{
  const db = createGatewayDb();
  const first = signedRequest('/internal/gateway/leases', {gateway_id: 'gateway-1', limit: 20}, {nonce: 'replay-nonce'});
  assert.equal((await call(first, db)).response.status, 200);
  const replay = await call(signedRequest('/internal/gateway/leases', {gateway_id: 'gateway-1', limit: 20}, {nonce: 'replay-nonce'}), db);
  assert.equal(replay.response.status, 409);
  assert.equal(replay.body.code, 'GATEWAY_REPLAY');
  assert(!JSON.stringify(db.calls).includes('replay-nonce'), 'only a nonce hash may reach D1');
  assert(db.calls.some(item => item.sql.includes("'+5 minutes'")), 'nonce hashes must expire after five minutes');
  const nonceInsert = db.calls.find(item => item.sql.includes('INSERT INTO bridge_gateway_nonces'));
  assert(!nonceInsert.sql.includes('bridge_accounts'), 'nonce consumption must not depend on any account row');
  assert.equal(nonceInsert.params[0], 'gateway-1', 'nonce replay keys must be gateway scoped');

  const independent = await call(signedRequest('/internal/gateway/leases', {gateway_id: 'gateway-2', limit: 20}, {
    gatewayId: 'gateway-2', secret: SECRET_TWO, nonce: 'replay-nonce'
  }), db);
  assert.equal(independent.response.status, 200, 'the same nonce must be independent for another allowed gateway');
}

{
  const db = createGatewayDb();
  db.sessions.length = 0;
  const leases = await call(signedRequest('/internal/gateway/leases', {gateway_id: 'gateway-1', limit: 20}), db);
  assert.equal(leases.response.status, 200, 'a signed lease poll with zero accounts must remain valid');
  assert.deepEqual(leases.body.leases, []);
  const heartbeat = await call(signedRequest('/internal/gateway/heartbeat', {gateway_id: 'gateway-1', connectors: []}), db);
  assert.equal(heartbeat.response.status, 200, 'an empty signed heartbeat must remain valid with zero accounts');
  assert.deepEqual(heartbeat.body, {ok: true, accepted: 0});
}

for (const request of [
  signedRequest('/internal/gateway/leases', {gateway_id: 'gateway-1', limit: 20}, {signature: 'a'.repeat(64)}),
  signedRequest('/internal/gateway/leases', {gateway_id: 'gateway-1', limit: 20}, {gatewayId: 'gateway-wrong'}),
  signedRequest('/internal/gateway/leases?region=two', {gateway_id: 'gateway-1', limit: 20}, {signedPath: '/internal/gateway/leases'})
]) {
  const result = await call(request);
  assert.equal(result.response.status, 401, 'tamper, unknown gateway, and query mismatch must fail');
  assert.equal(result.body.code, 'GATEWAY_UNAUTHORIZED');
}

{
  const db = createGatewayDb();
  const first = await call(signedRequest('/internal/gateway/leases', {gateway_id: 'gateway-1', limit: 20}), db);
  const exclusive = await call(signedRequest('/internal/gateway/leases', {gateway_id: 'gateway-1', limit: 20}), db);
  assert.equal(first.body.leases.length, 1);
  assert.equal(exclusive.body.leases.length, 0, 'an unexpired lease must be exclusive');
  assert.equal(Date.parse(first.body.leases[0].lease_expires_at) - NOW.getTime(), 60_000, 'lease must last exactly 60 seconds');
  db.leases[0].expires_at = new Date(NOW.getTime() - 1).toISOString();
  const expired = await call(signedRequest('/internal/gateway/leases', {gateway_id: 'gateway-1', limit: 20}), db);
  assert.equal(expired.body.leases.length, 1, 'an expired lease must be acquirable again');
}

{
  const db = createGatewayDb();
  const firstCycle = await call(signedRequest('/internal/gateway/leases', {gateway_id: 'gateway-1', limit: 20}), db);
  assert.equal(firstCycle.body.leases.length, 1);
  for (const state of ['disabled', 'decrypting', 'authenticating', 'compatibility_required', 'revoked']) {
    const heartbeat = await call(signedRequest('/internal/gateway/heartbeat', {
      gateway_id: 'gateway-1', connectors: [{account_id: 'account-active', state}]
    }), db);
    assert.equal(heartbeat.response.status, 200, `${state} must be an accepted heartbeat state`);
    assert.deepEqual(heartbeat.body, {ok: true, accepted: 1});
    assert.equal(db.sessions[0].status, 'pending', 'heartbeat must never overwrite cloud-session lifecycle status');
    assert.equal(db.leases[0].connector_state, state, 'heartbeat state belongs to the active gateway lease');
  }

  const heldCycle = await call(signedRequest('/internal/gateway/leases', {gateway_id: 'gateway-1', limit: 20}), db);
  assert.equal(heldCycle.body.leases.length, 0, 'the second cycle must respect the current exclusive lease');
  db.leases[0].expires_at = new Date(NOW.getTime() - 1).toISOString();
  const secondCycle = await call(signedRequest('/internal/gateway/leases', {gateway_id: 'gateway-1', limit: 20}), db);
  assert.equal(secondCycle.body.leases.length, 1, 'the next normal cycle must reacquire after lease expiry');
  assert.equal(db.sessions[0].status, 'pending', 'lease expiry and reacquisition must not alter cloud-session lifecycle');

  for (const connectors of [
    [{account_id: 'account-active', state: 'live'}],
    [{account_id: 'account-active', state: 'disabled', detail: 'credential-secret'}],
    [{account_id: 'account-unleased', state: 'disabled'}]
  ]) {
    const rejected = await call(signedRequest('/internal/gateway/heartbeat', {gateway_id: 'gateway-1', connectors}), db);
    assert.equal(rejected.response.status, 400, 'heartbeat states, fields, and lease ownership must be strict');
    assert.equal(rejected.body.code, 'GATEWAY_INVALID_HEARTBEAT');
    assert(!JSON.stringify(rejected.body).includes('credential-secret'));
  }
}

{
  const db = createGatewayDb();
  const response = await worker.fetch(signedRequest('/internal/gateway/leases', {gateway_id: 'gateway-1', limit: 20}, {
    timestamp: Math.floor(Date.now() / 1000)
  }), envFor(db));
  assert.equal(response.status, 200, 'Worker router must expose the internal gateway lease endpoint');
  const publicResponse = await worker.fetch(new Request('https://worker.example/v1/config'), envFor(db));
  assert(!JSON.stringify(await publicResponse.json()).includes('ciphertext-active'), 'public Worker routes must not expose ciphertext');
}

{
  const db = createGatewayDb();
  db.sessions.splice(0, db.sessions.length, ...Array.from({length: 25}, (_, index) => ({
    id: `session-${index}`,
    account_id: `account-${index}`,
    active_device_id: `device-${index}`,
    envelope_ciphertext: JSON.stringify({version: 1, ciphertext: 'x'.repeat(80_000)}),
    status: 'pending', account_status: 'active', device_status: 'active'
  })));
  const result = await call(signedRequest('/internal/gateway/leases', {gateway_id: 'gateway-1', limit: 999}), db);
  assert(result.body.leases.length <= 20, 'lease responses must contain at most 20 leases');
  assert(encoder.encode(JSON.stringify(result.body)).byteLength <= 1024 * 1024, 'lease responses must not exceed 1 MiB');
}

{
  const sensitive = 'database credential should stay private';
  const request = signedRequest('/internal/gateway/leases', {gateway_id: 'gateway-1', limit: 20});
  const response = await control.handle(request, {
    ...envFor(createGatewayDb()),
    DB: {prepare() { throw new Error(sensitive); }}
  });
  const redactedBody = response.clone();
  assert.equal(response.status, 503, 'internal storage failures must use a stable unavailable response');
  assert.deepEqual(await response.json(), {ok: false, code: 'GATEWAY_UNAVAILABLE'});
  assert(!JSON.stringify(await redactedBody.text()).includes(sensitive));
}

console.log('gateway control worker contract passed');
