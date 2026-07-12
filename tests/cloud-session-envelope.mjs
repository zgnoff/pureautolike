import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
await import('../src/cloud-session-envelope.js');

const gatewayKeys = await crypto.subtle.generateKey(
  {name: 'ECDH', namedCurve: 'P-256'},
  true,
  ['deriveBits']
);
const gatewayPublicKey = await crypto.subtle.exportKey('jwk', gatewayKeys.publicKey);
const session = {
  bearer: 'Bearer seeded-secret-token',
  xJsUserAgent: 'seeded-x-js-user-agent'
};

const envelope = await globalThis.PalCloudEnvelope.encryptSession({
  gatewayPublicKey,
  keyId: 'gateway-key-2026-07',
  accountBinding: 'pure-user-42',
  createdAt: 1783861200000,
  session
});

assert.equal(envelope.version, 1);
assert.equal(envelope.keyId, 'gateway-key-2026-07');
assert.equal(envelope.accountBinding, 'pure-user-42');
assert.equal(envelope.createdAt, 1783861200000);
assert.equal(envelope.ephemeralPublicKey.kty, 'EC');
assert.equal(envelope.ephemeralPublicKey.crv, 'P-256');
assert.equal(fromBase64Url(envelope.salt).byteLength, 32);
assert.equal(fromBase64Url(envelope.iv).byteLength, 12);

const serialized = JSON.stringify(envelope);
assert(!serialized.includes(session.bearer), 'serialized envelope must not contain the bearer');
assert(!serialized.includes(session.xJsUserAgent), 'serialized envelope must not contain x-js-user-agent');

const ephemeralPublicKey = await crypto.subtle.importKey(
  'jwk',
  envelope.ephemeralPublicKey,
  {name: 'ECDH', namedCurve: 'P-256'},
  false,
  []
);
const sharedSecret = await crypto.subtle.deriveBits(
  {name: 'ECDH', public: ephemeralPublicKey},
  gatewayKeys.privateKey,
  256
);
const hkdfKey = await crypto.subtle.importKey('raw', sharedSecret, 'HKDF', false, ['deriveKey']);
const aesKey = await crypto.subtle.deriveKey(
  {
    name: 'HKDF',
    hash: 'SHA-256',
    salt: fromBase64Url(envelope.salt),
    info: new TextEncoder().encode('pureautolike/cloud-session-envelope/v1')
  },
  hkdfKey,
  {name: 'AES-GCM', length: 256},
  false,
  ['decrypt']
);
const aad = new TextEncoder().encode(JSON.stringify({
  version: envelope.version,
  keyId: envelope.keyId,
  accountBinding: envelope.accountBinding,
  createdAt: envelope.createdAt
}));
const plaintext = await crypto.subtle.decrypt(
  {name: 'AES-GCM', iv: fromBase64Url(envelope.iv), additionalData: aad, tagLength: 128},
  aesKey,
  fromBase64Url(envelope.ciphertext)
);

assert.deepEqual(JSON.parse(new TextDecoder().decode(plaintext)), session);

const bridgeSource = await readFile(new URL('../src/page-bridge.js', import.meta.url), 'utf8');
const contentSource = await readFile(new URL('../src/content.js', import.meta.url), 'utf8');
const injectionSource = contentSource.slice(
  contentSource.indexOf('function injectPageBridge()'),
  contentSource.indexOf('function imageHashesFromUrls')
);
assert(injectionSource.includes("src/cloud-session-envelope.js"), 'content must load the envelope module');
assert(
  injectionSource.indexOf("src/cloud-session-envelope.js") < injectionSource.indexOf("src/page-bridge.js"),
  'content must load the envelope module before page-bridge'
);
for (const manifestPath of ['../manifest.json', '../manifests/chromium.json', '../manifests/firefox.json', '../manifests/safari.json']) {
  const manifest = JSON.parse(await readFile(new URL(manifestPath, import.meta.url), 'utf8'));
  assert(
    JSON.stringify(manifest.web_accessible_resources).includes('src/cloud-session-envelope.js'),
    `${manifestPath} must expose the envelope module to the page world`
  );
}
const buildSource = await readFile(new URL('../tools/build.mjs', import.meta.url), 'utf8');
assert(buildSource.includes("'src/cloud-session-envelope.js'"), 'build must copy the envelope module');
const pageMessages = [];
const encryptedInputs = [];
const bridgeContext = {
  location: {hostname: 'pure.app', href: 'https://pure.app/app'},
  document: {currentScript: {dataset: {palChannel: 'test-channel'}}, querySelector: () => null},
  Headers,
  Request,
  URL,
  Date,
  JSON,
  String,
  Number,
  Array,
  Object,
  Map,
  Set,
  Promise,
  Math,
  console,
  CSS: {escape: String},
  XMLHttpRequest: function XMLHttpRequest() {},
  WebSocket: function WebSocket() {},
  fetch: () => Promise.resolve({
    ok: true,
    status: 200,
    headers: new Headers(),
    clone: () => ({text: () => Promise.resolve('')})
  }),
  atob: value => Buffer.from(value, 'base64').toString('binary'),
  postMessage: message => pageMessages.push(message),
  addEventListener: (type, listener) => {
    if (type === 'message') bridgeContext.__messageHandler = listener;
  },
  PalCloudEnvelope: {
    encryptSession: async options => {
      encryptedInputs.push(options);
      return {version: 1, ciphertext: 'ciphertext-only'};
    }
  }
};
bridgeContext.XMLHttpRequest.prototype.open = function open() {};
bridgeContext.XMLHttpRequest.prototype.setRequestHeader = function setRequestHeader() {};
bridgeContext.XMLHttpRequest.prototype.send = function send() {};
bridgeContext.window = bridgeContext;
bridgeContext.globalThis = bridgeContext;
vm.createContext(bridgeContext);
vm.runInContext(bridgeSource, bridgeContext, {filename: 'src/page-bridge.js'});

const bearerPayload = Buffer.from(JSON.stringify({sub: 'pure-user-42'})).toString('base64url');
await bridgeContext.fetch('https://pure.app/api', {
  headers: {Authorization: `Bearer header.${bearerPayload}.signature`, 'x-js-user-agent': 'page-x-js'}
});
pageMessages.length = 0;
const exportRequest = {
  source: 'pal-content',
  channel: 'test-channel',
  type: 'cloud-session-export',
  requestId: 'request-1',
  gatewayPublicKey,
  keyId: 'gateway-key-2026-07',
  accountBinding: 'pure-user-42',
  createdAt: Date.now()
};
bridgeContext.__eventData = exportRequest;
vm.runInContext('__messageHandler({source: window, data: __eventData})', bridgeContext);
await new Promise(resolve => setTimeout(resolve, 0));
assert.equal(encryptedInputs.length, 1, 'valid cloud export must encrypt once');
assert.equal(JSON.stringify(encryptedInputs[0].session), JSON.stringify({
  bearer: `Bearer header.${bearerPayload}.signature`,
  xJsUserAgent: 'page-x-js'
}));
assert.equal(pageMessages[0].type, 'cloud-session-result');
assert.deepEqual(pageMessages[0].envelope, {version: 1, ciphertext: 'ciphertext-only'});
const resultSerialized = JSON.stringify(pageMessages[0]);
assert(!resultSerialized.includes('header.'), 'page message result must not contain the bearer');
assert(!resultSerialized.includes('page-x-js'), 'page message result must not contain x-js-user-agent');

for (const invalid of [
  {...exportRequest, channel: 'wrong-channel', requestId: 'bad-channel'},
  {...exportRequest, gatewayPublicKey: {...gatewayPublicKey, crv: 'P-384'}, requestId: 'bad-curve'},
  {...exportRequest, gatewayPublicKey: {...gatewayPublicKey, x: 'not-a-coordinate'}, requestId: 'bad-coordinate'},
  {...exportRequest, accountBinding: 'another-account', requestId: 'bad-account'},
  {...exportRequest, createdAt: Date.now() - 30001, requestId: 'stale'}
]) {
  bridgeContext.__eventData = invalid;
  vm.runInContext('__messageHandler({source: window, data: __eventData})', bridgeContext);
}
await new Promise(resolve => setTimeout(resolve, 0));
assert.equal(encryptedInputs.length, 1, 'invalid cloud exports must not reach encryption');
console.log('cloud session envelope crypto fixture passed');

function fromBase64Url(value) {
  return Uint8Array.from(Buffer.from(value, 'base64url'));
}
