import {readFile} from 'node:fs/promises';
import {dirname, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';

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
  'nonce_hash',
  'account_id',
  'signed_at',
  'expires_at',
  'consumed_at'
]);
assert(nonces.includes('REFERENCES bridge_accounts(id)'), 'gateway nonce account foreign key missing');

const leases = assertColumns('bridge_gateway_leases', [
  'id',
  'account_id',
  'device_id',
  'gateway_id',
  'lease_token_hash',
  'lease_seconds',
  'acquired_at',
  'expires_at',
  'released_at'
]);
assert(/lease_seconds\s+INTEGER\s+NOT\s+NULL\s+DEFAULT\s+60/i.test(leases), 'gateway lease must default to 60 seconds');
assert(/CHECK\s*\(\s*lease_seconds\s*=\s*60\s*\)/i.test(leases), 'gateway lease duration must be fixed at 60 seconds');
assert(leases.includes('REFERENCES bridge_accounts(id)'), 'gateway lease account foreign key missing');
assert(leases.includes('FOREIGN KEY (account_id, device_id) REFERENCES bridge_devices(account_id, id)'), 'leased device must belong to its account');

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
assertIndex('idx_bridge_gateway_nonces_expiry', 'bridge_gateway_nonces', ['expires_at', 'consumed_at']);
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
  (id, account_id, active_device_id, envelope_version, envelope_ciphertext, gateway_key_id, credential_fingerprint_hash)
VALUES ('session-cross-account', 'account-a', 'device-b', 1, 'ciphertext', 'key-1', 'fingerprint');
`, 'cloud sessions must reject a device owned by another account');

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
  (id, account_id, active_device_id, envelope_version, envelope_ciphertext, gateway_key_id, credential_fingerprint_hash)
VALUES ('session-valid', 'account-a', 'device-a', 1, 'ciphertext', 'key-1', 'fingerprint');
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

console.log('cloud gateway schema contract passed');
