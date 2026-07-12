import {readFile} from 'node:fs/promises';
import {dirname, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {createTelegramBridge} from '../backend/license-worker/src/telegram-bridge.js';
import {createFakeD1} from './helpers/fake-d1.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const schema = await readFile(resolve(root, 'backend/license-worker/schema.sql'), 'utf8');

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function tableSql(table) {
  const match = schema.match(new RegExp(
    `CREATE\\s+TABLE\\s+IF\\s+NOT\\s+EXISTS\\s+${table}\\s*\\(([\\s\\S]*?)\\);`,
    'i'
  ));
  assert(match, `missing ${table}`);
  return match[1];
}

function assertColumns(table, columns) {
  const sql = tableSql(table);
  for (const column of columns) {
    assert(new RegExp(`(^|\\n)\\s*${column}\\s+`, 'i').test(sql), `${table} missing ${column}`);
  }
  return sql;
}

function assertIndex(name, table, columns, {unique = false} = {}) {
  const uniqueSql = unique ? 'UNIQUE\\s+' : '';
  const columnSql = columns.join('\\s*,\\s*');
  const definition = new RegExp(
    `CREATE\\s+${uniqueSql}INDEX\\s+IF\\s+NOT\\s+EXISTS\\s+${name}\\s+ON\\s+${table}\\s*\\(\\s*${columnSql}\\s*\\)`,
    'i'
  );
  assert(definition.test(schema), `${name} must index ${table}(${columns.join(', ')})${unique ? ' uniquely' : ''}`);
}

function assertSqlRejected(statement, message, setup = '') {
  const result = spawnSync('sqlite3', [':memory:'], {
    encoding: 'utf8',
    input: `PRAGMA foreign_keys = ON;\n${schema}\n${sqlFixtureSetup}\n${setup}\n${statement}\n`
  });
  assert(result.status !== 0, message);
  assert(/constraint failed|foreign key mismatch/i.test(result.stderr), `${message}: unexpected SQLite error ${result.stderr}`);
}

function assertSqlAccepted(statement, message) {
  const result = spawnSync('sqlite3', [':memory:'], {
    encoding: 'utf8',
    input: `PRAGMA foreign_keys = ON;\n${schema}\n${sqlFixtureSetup}\n${statement}\nPRAGMA foreign_key_check;\n`
  });
  assert(result.status === 0, `${message}: ${result.stderr}`);
  assert(result.stdout.trim() === '', `${message}: foreign_key_check returned ${result.stdout}`);
}

const sqlFixtureSetup = `
INSERT INTO bridge_accounts (id) VALUES ('account-a'), ('account-b');
INSERT INTO bridge_devices (id, account_id, signing_public_jwk, encryption_public_jwk)
VALUES
  ('device-a', 'account-a', '{}', '{}'),
  ('device-b', 'account-b', '{}', '{}');
`;

const cloudTables = [
  'bridge_cloud_sessions',
  'bridge_cloud_consents',
  'bridge_gateway_nonces',
  'bridge_gateway_leases',
  'bridge_sync_state',
  'bridge_delivery_queue',
  'bridge_media_transfers'
];

for (const table of cloudTables) tableSql(table);

const devices = tableSql('bridge_devices');
assert(devices.includes('UNIQUE (account_id, id)'), 'bridge devices must expose a composite account ownership key');

const sessions = assertColumns('bridge_cloud_sessions', [
  'id',
  'account_id',
  'active_device_id',
  'envelope_version',
  'envelope_created_at',
  'envelope_ciphertext',
  'gateway_key_id',
  'credential_fingerprint_hash',
  'status',
  'created_at',
  'rotated_at',
  'last_used_at',
  'revoked_at'
]);
assert(sessions.includes('REFERENCES bridge_accounts(id)'), 'cloud session account foreign key missing');
assert(sessions.includes('UNIQUE (account_id)'), 'cloud sessions must allow only one row per account');
assert(sessions.includes('FOREIGN KEY (account_id, active_device_id) REFERENCES bridge_devices(account_id, id)'), 'cloud session device must belong to its account');

const consents = assertColumns('bridge_cloud_consents', [
  'id',
  'account_id',
  'device_id',
  'warning_version',
  'accepted_at'
]);
assert(consents.includes('UNIQUE (account_id, warning_version)'), 'cloud consent versions must be unique per account');
assert(consents.includes('REFERENCES bridge_accounts(id)'), 'cloud consent account foreign key missing');
assert(consents.includes('FOREIGN KEY (account_id, device_id) REFERENCES bridge_devices(account_id, id)'), 'consent device must belong to its account');

const nonces = assertColumns('bridge_gateway_nonces', [
  'gateway_id',
  'nonce_hash',
  'signed_at',
  'expires_at'
]);
assert(nonces.includes('PRIMARY KEY (gateway_id, nonce_hash)'), 'gateway replay keys must be scoped by gateway');
assert(!/account_id|REFERENCES\s+bridge_accounts/i.test(nonces), 'gateway nonces must not depend on account lifecycle');

const leases = assertColumns('bridge_gateway_leases', [
  'id',
  'account_id',
  'device_id',
  'gateway_id',
  'lease_token_hash',
  'lease_seconds',
  'connector_state',
  'heartbeat_at',
  'acquired_at',
  'expires_at',
  'released_at'
]);
assert(/lease_seconds\s+INTEGER\s+NOT\s+NULL\s+DEFAULT\s+60/i.test(leases), 'gateway lease must default to 60 seconds');
assert(/CHECK\s*\(\s*lease_seconds\s*=\s*60\s*\)/i.test(leases), 'gateway lease duration must be fixed at 60 seconds');
assert(/connector_state\s+TEXT\s+NOT\s+NULL\s+DEFAULT\s+'disabled'/i.test(leases), 'gateway lease connector state must default to disabled');
for (const state of ['disabled', 'decrypting', 'authenticating', 'compatibility_required', 'revoked']) {
  assert(leases.includes(`'${state}'`), `gateway lease connector state must enumerate ${state}`);
}
assert(leases.includes('REFERENCES bridge_accounts(id)'), 'gateway lease account foreign key missing');
assert(leases.includes('FOREIGN KEY (account_id, device_id) REFERENCES bridge_devices(account_id, id)'), 'leased device must belong to its account');

assertSqlAccepted(`
INSERT INTO bridge_accounts (id) VALUES ('account-nonce-only');
INSERT INTO bridge_gateway_nonces (gateway_id, nonce_hash, signed_at, expires_at)
VALUES ('gateway-1', 'nonce-hash', '2026-07-12T12:00:00Z', '2026-07-12T12:05:00Z');
DELETE FROM bridge_accounts WHERE id = 'account-nonce-only';
`, 'gateway replay records must survive unrelated account deletion');
assertSqlRejected(`
INSERT INTO bridge_gateway_leases
  (id, account_id, device_id, gateway_id, lease_token_hash, connector_state, expires_at)
VALUES ('lease-invalid-state', 'account-a', 'device-a', 'gateway-1', 'lease-state-hash', 'live', '2026-07-12T12:01:00Z');
`, 'gateway leases must reject non-enumerated connector states');

const syncState = assertColumns('bridge_sync_state', [
  'account_id',
  'mapping_id',
  'import_state',
  'chronological_cursor',
  'oldest_reached',
  'last_rest_watermark',
  'last_websocket_watermark',
  'imported_message_count',
  'last_success_at',
  'last_error_code',
  'updated_at'
]);
assert(syncState.includes('PRIMARY KEY (account_id, mapping_id)'), 'sync cursor must be unique per opaque mapping');
assert(syncState.includes('REFERENCES bridge_accounts(id)'), 'sync state account foreign key missing');

const queue = assertColumns('bridge_delivery_queue', [
  'command_id',
  'account_id',
  'target_device_id',
  'gateway_target',
  'mapping_id',
  'telegram_chat_id',
  'telegram_thread_id',
  'telegram_source_message_id',
  'command_kind',
  'payload_version',
  'payload_ciphertext',
  'created_at',
  'visible_at',
  'claimed_at',
  'claim_expires_at',
  'expires_at',
  'ttl_seconds',
  'visibility_timeout_seconds',
  'state',
  'attempt_count',
  'idempotency_key',
  'ordering_key'
]);
assert(/ttl_seconds\s+INTEGER\s+NOT\s+NULL\s+DEFAULT\s+86400/i.test(queue), 'delivery queue TTL must default to 24 hours');
assert(/visibility_timeout_seconds\s+INTEGER\s+NOT\s+NULL\s+DEFAULT\s+60/i.test(queue), 'delivery queue visibility timeout must default to 60 seconds');
assert(/CHECK\s*\(\s*ttl_seconds\s*=\s*86400\s*\)/i.test(queue), 'delivery queue TTL must be fixed at 24 hours');
assert(/CHECK\s*\(\s*visibility_timeout_seconds\s*=\s*60\s*\)/i.test(queue), 'delivery queue visibility timeout must be fixed at 60 seconds');
assert(queue.includes('UNIQUE (account_id, command_id)'), 'delivery queue command must be addressable within its account');
assert(queue.includes('REFERENCES bridge_accounts(id)'), 'delivery queue account foreign key missing');
assert(queue.includes('FOREIGN KEY (account_id, target_device_id) REFERENCES bridge_devices(account_id, id)'), 'queue target device must belong to its account');

const media = assertColumns('bridge_media_transfers', [
  'transfer_id',
  'account_id',
  'command_id',
  'media_kind',
  'mime_type',
  'byte_length',
  'content_hash',
  'status',
  'created_at',
  'expires_at',
  'deleted_at'
]);
assert(media.includes('FOREIGN KEY (account_id, command_id) REFERENCES bridge_delivery_queue(account_id, command_id)'), 'media transfer command must belong to its account');

assertIndex('idx_bridge_cloud_sessions_account_status', 'bridge_cloud_sessions', ['account_id', 'status']);
assertIndex('idx_bridge_cloud_consents_account_version', 'bridge_cloud_consents', ['account_id', 'warning_version'], {unique: true});
assertIndex('idx_bridge_gateway_nonces_expiry', 'bridge_gateway_nonces', ['expires_at']);
assertIndex('idx_bridge_gateway_leases_expiry', 'bridge_gateway_leases', ['expires_at', 'released_at']);
assertIndex('idx_bridge_sync_state_import', 'bridge_sync_state', ['account_id', 'import_state', 'updated_at']);
assertIndex('idx_bridge_delivery_queue_claim', 'bridge_delivery_queue', ['state', 'visible_at', 'claim_expires_at', 'expires_at']);
assertIndex('idx_bridge_delivery_queue_ordering', 'bridge_delivery_queue', ['account_id', 'ordering_key', 'created_at']);
assertIndex('idx_bridge_delivery_queue_idempotency', 'bridge_delivery_queue', ['account_id', 'idempotency_key'], {unique: true});
assertIndex('idx_bridge_media_transfers_expiry', 'bridge_media_transfers', ['status', 'expires_at']);

const forbiddenColumns = ['bearer', 'refresh_token', 'cookie_value', 'message_body', 'plaintext'];
const columnNames = [...schema.matchAll(/^\s*([a-z][a-z0-9_]*)\s+(?:TEXT|INTEGER|REAL|BLOB)\b/gim)]
  .map(match => match[1].toLowerCase());
for (const forbidden of forbiddenColumns) {
  assert(!columnNames.includes(forbidden), `schema must not define forbidden plaintext/credential column ${forbidden}`);
}

for (const forbidden of ['ciphertext', 'payload', 'body', 'url', 'path', 'content_blob', 'file_bytes']) {
  assert(!new RegExp(`(^|\\n)\\s*[a-z0-9_]*${forbidden}[a-z0-9_]*\\s+`, 'i').test(media), `media transfer must store metadata only, found ${forbidden}`);
}

assertSqlRejected(`
INSERT INTO bridge_cloud_sessions
  (id, account_id, active_device_id, envelope_version, envelope_created_at, envelope_ciphertext, gateway_key_id, credential_fingerprint_hash)
VALUES ('session-cross-account', 'account-a', 'device-b', 1, 1783857600000, 'ciphertext', 'key-1', 'fingerprint');
`, 'cloud sessions must reject a device owned by another account');

assertSqlRejected(`
INSERT INTO bridge_cloud_sessions
  (id, account_id, active_device_id, envelope_version, envelope_created_at, envelope_ciphertext, gateway_key_id, credential_fingerprint_hash)
VALUES
  ('session-account-first', 'account-a', 'device-a', 1, 1783857600000, 'ciphertext-1', 'key-1', 'fingerprint-1'),
  ('session-account-second', 'account-a', 'device-a', 1, 1783857600001, 'ciphertext-2', 'key-1', 'fingerprint-2');
`, 'cloud sessions must reject multiple rows for one account');

assertSqlRejected(`
INSERT INTO bridge_gateway_leases
  (id, account_id, device_id, gateway_id, lease_token_hash, lease_seconds, expires_at)
VALUES ('lease-invalid', 'account-a', 'device-a', 'gateway-1', 'lease-hash', 61, '2026-07-12T12:01:01Z');
`, 'gateway leases must reject durations other than 60 seconds');

const validQueueValues = `
  ('command-a', 'account-a', 'device-a', 'gateway-1', 'mapping-1', 'chat-1', 'thread-1', 'message-1', 'text', 1, 'ciphertext', '2026-07-13T12:00:00Z', 'idempotency-1', 'ordering-1')
`;
assertSqlRejected(`
INSERT INTO bridge_delivery_queue
  (command_id, account_id, target_device_id, gateway_target, mapping_id, telegram_chat_id, telegram_thread_id,
   telegram_source_message_id, command_kind, payload_version, payload_ciphertext, expires_at, idempotency_key, ordering_key,
   ttl_seconds)
VALUES
  ('command-invalid-ttl', 'account-a', 'device-a', 'gateway-1', 'mapping-1', 'chat-1', 'thread-1', 'message-1',
   'text', 1, 'ciphertext', '2026-07-13T12:00:00Z', 'idempotency-invalid-ttl', 'ordering-1', 86399);
`, 'delivery queue must reject TTLs other than 24 hours');

assertSqlRejected(`
INSERT INTO bridge_delivery_queue
  (command_id, account_id, target_device_id, gateway_target, mapping_id, telegram_chat_id, telegram_thread_id,
   telegram_source_message_id, command_kind, payload_version, payload_ciphertext, expires_at, idempotency_key, ordering_key,
   visibility_timeout_seconds)
VALUES
  ('command-invalid-visibility', 'account-a', 'device-a', 'gateway-1', 'mapping-1', 'chat-1', 'thread-1', 'message-1',
   'text', 1, 'ciphertext', '2026-07-13T12:00:00Z', 'idempotency-invalid-visibility', 'ordering-1', 61);
`, 'delivery queue must reject visibility timeouts other than 60 seconds');

assertSqlRejected(`
INSERT INTO bridge_media_transfers
  (transfer_id, account_id, command_id, media_kind, mime_type, byte_length, content_hash, expires_at)
VALUES ('transfer-cross-account', 'account-b', 'command-a', 'photo', 'image/jpeg', 10, 'content-hash', '2026-07-12T13:00:00Z');
`, 'media transfers must reject commands owned by another account', `
INSERT INTO bridge_delivery_queue
  (command_id, account_id, target_device_id, gateway_target, mapping_id, telegram_chat_id, telegram_thread_id,
   telegram_source_message_id, command_kind, payload_version, payload_ciphertext, expires_at, idempotency_key, ordering_key)
VALUES ${validQueueValues};
`);

assertSqlAccepted(`
INSERT INTO bridge_cloud_sessions
  (id, account_id, active_device_id, envelope_version, envelope_created_at, envelope_ciphertext, gateway_key_id, credential_fingerprint_hash)
VALUES ('session-valid', 'account-a', 'device-a', 1, 1783857600000, 'ciphertext', 'key-1', 'fingerprint');
INSERT INTO bridge_gateway_leases
  (id, account_id, device_id, gateway_id, lease_token_hash, expires_at)
VALUES ('lease-valid', 'account-a', 'device-a', 'gateway-1', 'lease-hash-valid', '2026-07-12T12:01:00Z');
INSERT INTO bridge_delivery_queue
  (command_id, account_id, target_device_id, gateway_target, mapping_id, telegram_chat_id, telegram_thread_id,
   telegram_source_message_id, command_kind, payload_version, payload_ciphertext, expires_at, idempotency_key, ordering_key)
VALUES ${validQueueValues};
INSERT INTO bridge_media_transfers
  (transfer_id, account_id, command_id, media_kind, mime_type, byte_length, content_hash, expires_at)
VALUES ('transfer-valid', 'account-a', 'command-a', 'photo', 'image/jpeg', 10, 'content-hash', '2026-07-12T13:00:00Z');
`, 'valid same-account cloud references must load with SQLite foreign keys enabled');

const cloudNow = new Date('2026-07-12T12:00:00.000Z');
const cloudBridge = createTelegramBridge({
  now: () => cloudNow,
  randomUUID: (() => {
    let counter = 900;
    return () => `00000000-0000-4000-8000-${String(++counter).padStart(12, '0')}`;
  })()
});
const cloudDb = createFakeD1();
const cloudToken = 'cloud-device-session-token';
let accountStatus = 'active';
let deviceStatus = 'active';
let consentWarningVersion = '';
let storedCloudSession = null;
let forceAtomicZeroChanges = false;
let deleteAfterAtomicUpsert = false;
cloudDb.when('FROM bridge_sessions s', () => ({
  account_id: 'account-cloud-1',
  device_id: 'device-cloud-1',
  session_expires_at: '2026-07-12T12:10:00.000Z',
  device_status: deviceStatus,
  account_status: accountStatus,
  telegram_chat_id: '12345'
}));
cloudDb.when('FROM bridge_cloud_consents', () => consentWarningVersion ? ({
  warning_version: consentWarningVersion,
  accepted_at: '2026-07-12T12:00:00.000Z'
}) : null);
cloudDb.when('INSERT INTO bridge_cloud_consents', ({params}) => {
  consentWarningVersion = String(params[3]);
  return {success: true, meta: {changes: 1}};
});
cloudDb.when('FROM bridge_cloud_sessions', () => storedCloudSession);
cloudDb.when('INSERT INTO bridge_cloud_sessions', ({sql, params}) => {
  if (forceAtomicZeroChanges) return {success: true, meta: {changes: 0}};
  const isRotation = !!storedCloudSession;
  if (!storedCloudSession) {
    storedCloudSession = {
      id: params[0],
      active_device_id: params[2],
      envelope_version: params[3],
      envelope_created_at: params[4],
      envelope_ciphertext: params[5],
      gateway_key_id: params[6],
      credential_fingerprint_hash: params[7],
      status: 'pending',
      created_at: '2026-07-12T12:00:00.000Z',
      rotated_at: null,
      last_used_at: null
    };
  } else if (params[4] > storedCloudSession.envelope_created_at) {
    storedCloudSession = {
      ...storedCloudSession,
      active_device_id: params[2],
      envelope_version: params[3],
      envelope_created_at: params[4],
      envelope_ciphertext: params[5],
      gateway_key_id: params[6],
      credential_fingerprint_hash: params[7],
      status: 'pending',
      rotated_at: '2026-07-12T12:00:00.000Z',
      last_used_at: null
    };
  } else {
    return {success: true, meta: {changes: 0}};
  }
  assert(sql.includes('ON CONFLICT(account_id) DO UPDATE'), 'cloud upload must use an atomic account upsert');
  assert(sql.includes('excluded.envelope_created_at > bridge_cloud_sessions.envelope_created_at'), 'atomic rotation must reject equal or older envelopes');
  assert(isRotation === !!storedCloudSession.rotated_at, 'fake D1 rotation state must match the upsert path');
  if (deleteAfterAtomicUpsert) storedCloudSession = null;
  return {success: true, meta: {changes: 1}};
});
cloudDb.when('DELETE FROM bridge_cloud_sessions', () => {
  storedCloudSession = null;
  return {success: true, meta: {changes: 1}};
});

const gatewayPublicJwk = {
  kty: 'EC',
  crv: 'P-256',
  x: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
  y: 'BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBQ'
};
const cloudEnv = (overrides = {}) => ({
  DB: cloudDb,
  GATEWAY_PUBLIC_JWK: JSON.stringify(gatewayPublicJwk),
  GATEWAY_KEY_ID: 'gateway-key-2026-07',
  CLOUD_TEST_ENABLED: 'true',
  CLOUD_TEST_ACCOUNT_IDS: 'account-cloud-1,account-other',
  CLOUD_WARNING_VERSION: 'cloud-risk-v1',
  ...overrides
});
const cloudRequest = (path, {method = 'GET', body, token = cloudToken} = {}) => new Request(
  `https://worker.example${path}`,
  {
    method,
    headers: {
      ...(token ? {Authorization: `Bearer ${token}`} : {}),
      ...(body === undefined ? {} : {'Content-Type': 'application/json'})
    },
    ...(body === undefined ? {} : {body: typeof body === 'string' ? body : JSON.stringify(body)})
  }
);
const callCloud = (path, options, env = cloudEnv()) => cloudBridge.handle(cloudRequest(path, options), env);
const validEnvelope = (overrides = {}) => ({
  version: 1,
  keyId: 'gateway-key-2026-07',
  accountBinding: 'account-cloud-1',
  createdAt: cloudNow.getTime(),
  ephemeralPublicKey: gatewayPublicJwk,
  salt: 'A'.repeat(43),
  iv: 'B'.repeat(16),
  ciphertext: 'C'.repeat(64),
  ...overrides
});

const configResponse = await callCloud('/v1/cloud/config');
assert(configResponse?.status === 200, 'authenticated active device must receive cloud config');
const config = await configResponse.json();
assert(config.ok && config.test_mode === true, 'cloud config must identify test mode');
assert(config.account_binding === 'account-cloud-1', 'cloud config must bind envelopes to the authenticated account');
assert(config.warning_version === 'cloud-risk-v1', 'cloud config must return the exact warning version');
assert(config.gateway_key_id === 'gateway-key-2026-07', 'cloud config must expose the configured key id');
assert(JSON.stringify(config.gateway_public_jwk) === JSON.stringify(gatewayPublicJwk), 'cloud config must expose the configured public JWK');

const missingAuthResponse = await callCloud('/v1/cloud/config', {token: ''});
assert(missingAuthResponse.status === 401, 'cloud config must require a device session');

const disabledResponse = await callCloud('/v1/cloud/config', {}, cloudEnv({CLOUD_TEST_ENABLED: 'false'}));
assert(disabledResponse.status === 403 && (await disabledResponse.json()).code === 'CLOUD_TEST_DISABLED', 'disabled cloud test mode must use CLOUD_TEST_DISABLED');
const deniedAccountResponse = await callCloud('/v1/cloud/config', {}, cloudEnv({CLOUD_TEST_ACCOUNT_IDS: 'account-other'}));
assert(deniedAccountResponse.status === 403 && (await deniedAccountResponse.json()).code === 'CLOUD_TEST_DISABLED', 'non-allowlisted account must use CLOUD_TEST_DISABLED');

accountStatus = 'suspended';
const inactiveResponse = await callCloud('/v1/cloud/status');
assert(inactiveResponse.status === 403 && (await inactiveResponse.json()).code === 'ACCOUNT_INACTIVE', 'inactive account must use ACCOUNT_INACTIVE');
accountStatus = 'active';
deviceStatus = 'revoked';
assert((await callCloud('/v1/cloud/status')).status === 403, 'inactive device must not use cloud routes');
deviceStatus = 'active';

const preConsentUpload = await callCloud('/v1/cloud/session', {
  method: 'PUT',
  body: {envelope: validEnvelope(), credential_fingerprint_hash: 'fingerprint-hash-1'}
});
assert(preConsentUpload.status === 403 && (await preConsentUpload.json()).code === 'CONSENT_REQUIRED', 'upload before exact consent must use CONSENT_REQUIRED');

const wrongWarningResponse = await callCloud('/v1/cloud/consent', {
  method: 'POST',
  body: {warning_version: 'cloud-risk-old'}
});
assert(wrongWarningResponse.status === 400 && (await wrongWarningResponse.json()).code === 'CONSENT_REQUIRED', 'consent must require the configured warning version');
const malformedConsentResponse = await callCloud('/v1/cloud/consent', {
  method: 'POST',
  body: '{not-json'
});
assert(malformedConsentResponse.status === 400 && (await malformedConsentResponse.json()).code === 'INVALID_ENVELOPE', 'malformed cloud consent JSON must use INVALID_ENVELOPE');
const consentResponse = await callCloud('/v1/cloud/consent', {
  method: 'POST',
  body: {warning_version: 'cloud-risk-v1'}
});
assert(consentResponse.status === 200 && (await consentResponse.json()).warning_version === 'cloud-risk-v1', 'exact warning consent must be recorded');

for (const envelope of [
  validEnvelope({version: 2}),
  validEnvelope({accountBinding: 'account-other'}),
  validEnvelope({ephemeralPublicKey: {...gatewayPublicJwk, crv: 'P-384'}}),
  validEnvelope({ephemeralPublicKey: {...gatewayPublicJwk, d: 'private-key-material'}}),
  validEnvelope({ephemeralPublicKey: {...gatewayPublicJwk, x: 'short'}}),
  validEnvelope({salt: 'not base64!'}),
  validEnvelope({iv: 'tiny'}),
  validEnvelope({ciphertext: ''})
]) {
  const response = await callCloud('/v1/cloud/session', {
    method: 'PUT',
    body: {envelope, credential_fingerprint_hash: 'fingerprint-hash-1'}
  });
  assert(response.status === 400 && (await response.json()).code === 'INVALID_ENVELOPE', 'malformed or cross-account envelope must use INVALID_ENVELOPE');
}
const wrongKeyResponse = await callCloud('/v1/cloud/session', {
  method: 'PUT',
  body: {envelope: validEnvelope({keyId: 'gateway-key-old'}), credential_fingerprint_hash: 'fingerprint-hash-1'}
});
assert(wrongKeyResponse.status === 409 && (await wrongKeyResponse.json()).code === 'GATEWAY_KEY_MISMATCH', 'wrong gateway key binding must use GATEWAY_KEY_MISMATCH');

const oversizedEnvelopeResponse = await callCloud('/v1/cloud/session', {
  method: 'PUT',
  body: {envelope: validEnvelope({ciphertext: 'C'.repeat(65537)}), credential_fingerprint_hash: 'fingerprint-hash-1'}
});
assert(oversizedEnvelopeResponse.status === 413 && (await oversizedEnvelopeResponse.json()).code === 'INVALID_ENVELOPE', 'serialized envelope over 64 KiB must use INVALID_ENVELOPE');
const oversizedBodyResponse = await callCloud('/v1/cloud/session', {
  method: 'PUT',
  body: JSON.stringify({padding: 'x'.repeat(65536)})
});
assert(oversizedBodyResponse.status === 413 && (await oversizedBodyResponse.json()).code === 'INVALID_ENVELOPE', 'cloud request body over 64 KiB must use INVALID_ENVELOPE');

for (const body of ['', '{not-json']) {
  const response = await callCloud('/v1/cloud/session', {method: 'PUT', body});
  assert(response.status === 400 && (await response.json()).code === 'INVALID_ENVELOPE', 'empty or malformed JSON must return 400 INVALID_ENVELOPE');
}

const contentLengthResponse = await cloudBridge.handle(new Request('https://worker.example/v1/cloud/session', {
  method: 'PUT',
  headers: {
    Authorization: `Bearer ${cloudToken}`,
    'Content-Type': 'application/json',
    'Content-Length': String(65537)
  },
  body: '{}'
}), cloudEnv());
assert(contentLengthResponse.status === 413, 'declared cloud body over 64 KiB must be rejected before parsing');

let streamedBodyCanceled = false;
let streamedBodyPulls = 0;
const oversizedStream = new ReadableStream({
  pull(controller) {
    streamedBodyPulls += 1;
    controller.enqueue(new Uint8Array(40000));
  },
  cancel() {
    streamedBodyCanceled = true;
  }
});
const streamedOversizeResponse = await cloudBridge.handle(new Request('https://worker.example/v1/cloud/session', {
  method: 'PUT',
  headers: {
    Authorization: `Bearer ${cloudToken}`,
    'Content-Type': 'application/json'
  },
  body: oversizedStream,
  duplex: 'half'
}), cloudEnv());
assert(streamedOversizeResponse.status === 413, 'chunked cloud body over 64 KiB must return 413');
assert(streamedBodyCanceled, 'oversized chunked body reader must be canceled immediately');
assert(streamedBodyPulls <= 3, 'oversized chunked body must stop reading after crossing the limit');

const cancelRejectingStream = new ReadableStream({
  pull(controller) {
    controller.enqueue(new Uint8Array(40000));
  },
  cancel() {
    throw new Error('seeded cancel rejection');
  }
});
const cancelRejectingOversizeResponse = await cloudBridge.handle(new Request('https://worker.example/v1/cloud/session', {
  method: 'PUT',
  headers: {
    Authorization: `Bearer ${cloudToken}`,
    'Content-Type': 'application/json'
  },
  body: cancelRejectingStream,
  duplex: 'half'
}), cloudEnv());
assert(cancelRejectingOversizeResponse.status === 413, 'reader cancellation rejection must not replace a proven oversize 413');

for (const createdAt of [cloudNow.getTime() - 30001, cloudNow.getTime() + 30001]) {
  const response = await callCloud('/v1/cloud/session', {
    method: 'PUT',
    body: {envelope: validEnvelope({createdAt}), credential_fingerprint_hash: 'fingerprint-hash-1'}
  });
  assert(response.status === 400 && (await response.json()).code === 'INVALID_ENVELOPE', 'stale or future activation envelope must use INVALID_ENVELOPE');
}

const createdResponse = await callCloud('/v1/cloud/session', {
  method: 'PUT',
  body: {envelope: validEnvelope(), credential_fingerprint_hash: 'fingerprint-hash-1'}
});
assert(createdResponse.status === 201, 'first valid cloud session upload must return 201');
const created = await createdResponse.json();
assert(created.status === 'pending' && !JSON.stringify(created).includes('C'.repeat(32)), 'upload response must be redacted');
const originalSessionId = storedCloudSession.id;

for (const createdAt of [cloudNow.getTime(), cloudNow.getTime() - 1]) {
  const response = await callCloud('/v1/cloud/session', {
    method: 'PUT',
    body: {envelope: validEnvelope({createdAt, ciphertext: 'R'.repeat(64)}), credential_fingerprint_hash: 'fingerprint-replay'}
  });
  assert(response.status === 400 && (await response.json()).code === 'INVALID_ENVELOPE', 'equal or rollback rotation must use INVALID_ENVELOPE');
  assert(storedCloudSession.credential_fingerprint_hash === 'fingerprint-hash-1', 'replayed rotation must not replace stored session metadata');
}

forceAtomicZeroChanges = true;
const zeroChangeResponse = await callCloud('/v1/cloud/session', {
  method: 'PUT',
  body: {envelope: validEnvelope({createdAt: cloudNow.getTime() + 1}), credential_fingerprint_hash: 'fingerprint-race'}
});
forceAtomicZeroChanges = false;
assert(zeroChangeResponse.status === 400 && (await zeroChangeResponse.json()).code === 'INVALID_ENVELOPE', 'zero-change atomic upsert must not return false success');

const beforeConcurrentDelete = storedCloudSession;
deleteAfterAtomicUpsert = true;
const concurrentDeleteResponse = await callCloud('/v1/cloud/session', {
  method: 'PUT',
  body: {envelope: validEnvelope({createdAt: cloudNow.getTime() + 1}), credential_fingerprint_hash: 'fingerprint-deleted'}
});
deleteAfterAtomicUpsert = false;
assert(concurrentDeleteResponse.status === 400 && (await concurrentDeleteResponse.json()).code === 'INVALID_ENVELOPE', 'concurrent deletion after atomic upsert must not return false success');
storedCloudSession = beforeConcurrentDelete;

const rotatedResponse = await callCloud('/v1/cloud/session', {
  method: 'PUT',
  body: {envelope: validEnvelope({createdAt: cloudNow.getTime() + 2, ciphertext: 'D'.repeat(64)}), credential_fingerprint_hash: 'fingerprint-hash-2'}
});
assert(rotatedResponse.status === 200, 'rotating a cloud session must return 200');
assert(storedCloudSession.id === originalSessionId, 'rotation must preserve the cloud session identity');
assert(storedCloudSession.envelope_ciphertext.includes('D'.repeat(32)), 'rotation must replace the stored envelope');
assert(cloudDb.calls.some(call => call.sql.includes('INSERT INTO bridge_cloud_sessions') && call.sql.includes('rotated_at = CURRENT_TIMESTAMP')), 'atomic rotation must record rotated_at');
assert(!cloudDb.calls.some(call => /^\s*UPDATE bridge_cloud_sessions/.test(call.sql)), 'cloud rotation must not use a separate UPDATE statement');

const statusResponse = await callCloud('/v1/cloud/status');
const status = await statusResponse.json();
assert(statusResponse.status === 200 && status.configured === true && status.status === 'pending', 'status must report configured cloud state');
assert(status.gateway_key_id === 'gateway-key-2026-07' && status.credential_fingerprint_hash === 'fingerprint-hash-2', 'status must expose only redacted metadata');
assert(!Object.hasOwn(status, 'envelope_ciphertext') && !Object.hasOwn(status, 'ciphertext') && !JSON.stringify(status).includes('D'.repeat(32)), 'status must never return stored ciphertext');

const deleteResponse = await callCloud('/v1/cloud/session', {method: 'DELETE'});
assert(deleteResponse.status === 200 && (await deleteResponse.json()).configured === false, 'deactivation must report unconfigured');
for (const table of ['bridge_gateway_leases', 'bridge_media_transfers', 'bridge_delivery_queue', 'bridge_sync_state', 'bridge_cloud_sessions']) {
  assert(cloudDb.calls.some(call => call.sql.includes(`DELETE FROM ${table}`)), `deactivation must clean ${table}`);
}
const repeatedDeleteResponse = await callCloud('/v1/cloud/session', {method: 'DELETE'});
assert(repeatedDeleteResponse.status === 200 && (await repeatedDeleteResponse.json()).configured === false, 'deactivation must be idempotent');

console.log('cloud gateway schema contract passed');
