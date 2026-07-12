import {readFile} from 'node:fs/promises';
import {dirname, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

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
assert(sessions.includes('REFERENCES bridge_devices(id)'), 'cloud session device foreign key missing');

const consents = assertColumns('bridge_cloud_consents', [
  'id',
  'account_id',
  'device_id',
  'warning_version',
  'accepted_at'
]);
assert(consents.includes('UNIQUE (account_id, warning_version)'), 'cloud consent versions must be unique per account');
assert(consents.includes('REFERENCES bridge_accounts(id)'), 'cloud consent account foreign key missing');
assert(consents.includes('REFERENCES bridge_devices(id)'), 'cloud consent device foreign key missing');

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
assert(leases.includes('REFERENCES bridge_accounts(id)'), 'gateway lease account foreign key missing');
assert(leases.includes('REFERENCES bridge_devices(id)'), 'gateway lease device foreign key missing');

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
assert(queue.includes('REFERENCES bridge_accounts(id)'), 'delivery queue account foreign key missing');
assert(queue.includes('REFERENCES bridge_devices(id)'), 'delivery queue device foreign key missing');

assertColumns('bridge_media_transfers', [
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

for (const index of [
  'idx_bridge_cloud_sessions_account_status',
  'idx_bridge_cloud_consents_account_version',
  'idx_bridge_gateway_nonces_expiry',
  'idx_bridge_gateway_leases_expiry',
  'idx_bridge_sync_state_import',
  'idx_bridge_delivery_queue_claim',
  'idx_bridge_delivery_queue_ordering',
  'idx_bridge_delivery_queue_idempotency',
  'idx_bridge_media_transfers_expiry'
]) {
  assert(schema.includes(`INDEX IF NOT EXISTS ${index}`), `missing ${index}`);
}

const forbiddenColumns = ['bearer', 'refresh_token', 'cookie_value', 'message_body', 'plaintext'];
const columnNames = [...schema.matchAll(/^\s*([a-z][a-z0-9_]*)\s+(?:TEXT|INTEGER|REAL|BLOB)\b/gim)]
  .map(match => match[1].toLowerCase());
for (const forbidden of forbiddenColumns) {
  assert(!columnNames.includes(forbidden), `schema must not define forbidden plaintext/credential column ${forbidden}`);
}

const media = tableSql('bridge_media_transfers');
for (const forbidden of ['ciphertext', 'payload', 'body', 'url', 'path', 'content_blob', 'file_bytes']) {
  assert(!new RegExp(`(^|\\n)\\s*[a-z0-9_]*${forbidden}[a-z0-9_]*\\s+`, 'i').test(media), `media transfer must store metadata only, found ${forbidden}`);
}

console.log('cloud gateway schema contract passed');
