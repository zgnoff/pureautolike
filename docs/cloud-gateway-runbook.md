# Cloud Gateway Controlled-Test Runbook

This runbook prepares the encrypted Pure cloud gateway for an owner-only test.
It does not authorize a deployment now. Do not call Pure, enable imports, send
messages, or set `CLOUD_TEST_ENABLED` to true until the stop gate at the end is
fully satisfied.

All values in angle brackets are placeholders. Never paste live Pure
credentials, gateway private keys, HMAC secrets, Telegram tokens, or Worker
tokens into source control, shell history, tickets, or logs.

## Safety boundary

- The browser encrypts an active Pure session credential into an encrypted Pure
  credential envelope using the gateway's pinned `GATEWAY_PUBLIC_JWK`.
- The VPS stores `GATEWAY_PRIVATE_JWK` as a private secret and decrypts only in
  process memory. The service does not ask for or receive a Pure password.
- This is not end-to-end encryption: the gateway must use the decrypted session
  credential to communicate with Pure.
- All controlled-test accounts share the gateway's server IP. Pure may restrict
  or block them. Allowlist only owner-operated test accounts that accepted the current warning.
- The future Telegram-to-Pure delivery queue has a fixed 24-hour expiry. Sending
  remains disabled during this foundation test.
- `CLOUD_TEST_ENABLED = "false"` is the default and the rollback position.

## 1. Generate and separate the gateway key

On the intended gateway host, replace `<SECURE_WORKDIR>` with a directory on an
encrypted filesystem. Generate a P-256 ECDH key pair with restrictive defaults:

```bash
install -d -m 700 <SECURE_WORKDIR>
umask 077
GATEWAY_KEY_DIR=<SECURE_WORKDIR> node --input-type=module <<'NODE'
import { generateKeyPairSync } from 'node:crypto';
import { writeFileSync } from 'node:fs';

const directory = process.env.GATEWAY_KEY_DIR;
const {publicKey, privateKey} = generateKeyPairSync('ec', {namedCurve: 'prime256v1'});
writeFileSync(`${directory}/gateway-public.jwk`, JSON.stringify(publicKey.export({format: 'jwk'})) + '\n', {mode: 0o644});
writeFileSync(`${directory}/gateway-private.jwk`, JSON.stringify(privateKey.export({format: 'jwk'})) + '\n', {mode: 0o600});
NODE
chmod 600 <SECURE_WORKDIR>/gateway-private.jwk
```

Pin the one-line public file as Worker `GATEWAY_PUBLIC_JWK` and assign a unique
`GATEWAY_KEY_ID`, for example `<GATEWAY_KEY_ID>`. Put only the matching one-line
private file in the VPS environment as `GATEWAY_PRIVATE_JWK`. The public pin may be distributed;
the private JWK must never leave secret storage.

## 2. Provision Worker configuration and secrets

In `backend/license-worker`, keep the test disabled and the allowlist empty while
provisioning:

```toml
GATEWAY_PUBLIC_JWK = '<ONE_LINE_PUBLIC_JWK>'
GATEWAY_KEY_ID = "<GATEWAY_KEY_ID>"
CLOUD_TEST_ENABLED = "false"
CLOUD_TEST_ACCOUNT_IDS = ""
CLOUD_WARNING_VERSION = "<WARNING_VERSION>"
```

Generate an independent random HMAC secret using the host secret manager. Store
a JSON gateway-id-to-secret map as a Cloudflare secret, never a plaintext
Wrangler variable:

```bash
cd backend/license-worker
printf '%s' '{"<GATEWAY_ID>":"<HMAC_SECRET>"}' | npx wrangler secret put GATEWAY_HMAC_SECRETS
```

Do not use the Pure session credential or the gateway private key as the HMAC
secret.

## 3. Inspect and apply the D1 schema

First inspect whether cloud tables already exist and, if they do, which shape is
installed:

```bash
cd backend/license-worker
npx wrangler d1 execute pureautolike_license --remote --command "SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'bridge_%';"
npx wrangler d1 execute pureautolike_license --remote --command "PRAGMA table_info('bridge_cloud_sessions');"
npx wrangler d1 execute pureautolike_license --remote --command "PRAGMA table_info('bridge_gateway_nonces');"
```

The known deployed database predates every cloud table. For that database, apply
the complete bootstrap schema exactly once; `CREATE TABLE IF NOT EXISTS` creates
the missing tables:

```bash
npx wrangler d1 execute pureautolike_license --remote --file schema.sql
```

Only an intermediate installation needs a migration: that means a cloud table
already exists but `bridge_cloud_sessions` lacks `envelope_created_at` or
account uniqueness, or `bridge_gateway_nonces` lacks the composite
`(gateway_id, nonce_hash)` primary key. Stop if either condition is observed.
Back up that D1 database, review the migration for its exact starting shape, and
then use the reviewed file placeholder below; do not run `schema.sql` as though
it could alter an existing incompatible table:

```bash
npx wrangler d1 export pureautolike_license --remote --output <ENCRYPTED_BACKUP_PATH>/pre-cloud-migration.sql
npx wrangler d1 execute pureautolike_license --remote --file <REVIEWED_INTERMEDIATE_MIGRATION.sql>
```

Re-run both `PRAGMA table_info` commands and `PRAGMA foreign_key_check` before
continuing.

## 4. Prepare the encrypted spool mount and systemd environment

The systemd unit requires `/var/lib/pureautolike-gateway/spool`. It must be a
mounted encrypted filesystem (for example LUKS/dm-crypt), not merely a directory
on the unencrypted root filesystem. Provision and unlock that mount outside this
runbook, then verify the prerequisite before starting the service:

```bash
findmnt --target /var/lib/pureautolike-gateway/spool
lsblk -f
test "$(findmnt -n -o TARGET --target /var/lib/pureautolike-gateway/spool)" = "/var/lib/pureautolike-gateway/spool"
```

Create `/etc/pureautolike/gateway.env` through the host secret manager with only
placeholder-shaped values like these:

```dotenv
CONTROL_PLANE_URL=<HTTPS_WORKER_ORIGIN>
GATEWAY_ID=<GATEWAY_ID>
GATEWAY_HMAC_SECRET=<HMAC_SECRET>
GATEWAY_PRIVATE_JWK=<ONE_LINE_PRIVATE_JWK>
GATEWAY_KEY_ID=<GATEWAY_KEY_ID>
```

Restrict ownership and permissions, install the reviewed unit, and validate it:

```bash
chown root:pureautolike-gateway /etc/pureautolike/gateway.env
chmod 600 /etc/pureautolike/gateway.env
install -o root -g root -m 0644 backend/pure-gateway/deploy/pureautolike-gateway.service /etc/systemd/system/pureautolike-gateway.service
systemd-analyze verify /etc/systemd/system/pureautolike-gateway.service
systemctl daemon-reload
```

The hardened unit keeps exactly one writable service path:

```ini
ReadWritePaths=/var/lib/pureautolike-gateway/spool
```

Do not start or enable the unit during preparation.

## 5. Pre-enable health checks

Run local checks without any Pure credentials or network calls to Pure:

```bash
npm run validate
npm run audit:clean
npm run build
npm --prefix backend/license-worker run check
node tests/cloud-gateway-worker.mjs
npm --prefix backend/pure-gateway test
npm --prefix backend/pure-gateway run check
git diff --check
```

After an authorized test deployment, service health is checked with metadata and
redacted logs only:

```bash
systemctl is-active pureautolike-gateway
systemctl show pureautolike-gateway -p ActiveState -p SubState -p NRestarts
journalctl -u pureautolike-gateway --since '-10 minutes' --no-pager
curl -fsS <HTTPS_WORKER_ORIGIN>/v1/config
```

Logs must contain stable event/error codes, never credentials, private JWK
members, envelope ciphertext, message bodies, or HMAC signatures.

## 6. Kill switch and rollback

The immediate kill switch is Worker-side denial plus gateway shutdown. Keep the
following Wrangler setting committed before any rollout:

```toml
CLOUD_TEST_ENABLED = "false"
```

For an authorized emergency response, set/confirm that value, deploy the Worker,
and stop the gateway:

```bash
cd backend/license-worker
npx wrangler deploy src/worker.js
systemctl stop pureautolike-gateway
systemctl is-inactive pureautolike-gateway
```

Rollback keeps the kill switch false. The release layout must use
`/opt/pureautolike/backend/pure-gateway` as a symlink to an immutable directory
under `/opt/pureautolike/releases`. Restore the previous Worker public pin,
gateway artifact, and complete permission-restricted environment file (including
the matching private JWK) with placeholders only:

```bash
cd backend/license-worker
npx wrangler deploy src/worker.js \
  --var "GATEWAY_PUBLIC_JWK:<ROLLBACK_ONE_LINE_PUBLIC_JWK>" \
  --var "GATEWAY_KEY_ID:<ROLLBACK_GATEWAY_KEY_ID>" \
  --var "CLOUD_TEST_ENABLED:false"
systemctl stop pureautolike-gateway
test -d /opt/pureautolike/releases/<PREVIOUS_RELEASE>/backend/pure-gateway
ln -sfn /opt/pureautolike/releases/<PREVIOUS_RELEASE>/backend/pure-gateway /opt/pureautolike/backend/pure-gateway.next
mv -Tf /opt/pureautolike/backend/pure-gateway.next /opt/pureautolike/backend/pure-gateway
install -o root -g pureautolike-gateway -m 0600 <ROLLBACK_GATEWAY_ENV_FILE> /etc/pureautolike/gateway.env
systemctl daemon-reload
systemctl restart pureautolike-gateway
systemctl status pureautolike-gateway --no-pager
journalctl -u pureautolike-gateway --since '-10 minutes' --no-pager
```

`<ROLLBACK_GATEWAY_ENV_FILE>` must be rendered by the secret manager and contain
the rollback `GATEWAY_PRIVATE_JWK`; do not construct it in shell history. Re-run
the pre-enable checks after restoration. Never roll back the D1 schema
destructively; restore `<ENCRYPTED_BACKUP_PATH>` only under a reviewed incident
plan.

## 7. Key rotation

This rotation procedure applies only after the protocol fixture gate opens and
an authorized controlled deployment already exists. Before that point, do not restart the gateway
and do not run any Worker, secret, environment, or systemd mutation below. The
literal placeholder guards intentionally fail until an authorized operator
replaces them with externally verified gate values:

```bash
test "<PROTOCOL_FIXTURE_GATE>" = "open"
test "<AUTHORIZED_CONTROLLED_DEPLOYMENT>" = "yes"
```

After both guards succeed, rotation is a staged re-encryption, not an in-place
private-key overwrite:

1. Generate a new P-256 pair and a new `<NEW_GATEWAY_KEY_ID>` using section 1.
2. Have the secret manager render `<NEW_GATEWAY_ENV_FILE>` with the new
   `GATEWAY_PRIVATE_JWK`, `<NEW_GATEWAY_ID>`, `<NEW_HMAC_SECRET>`, and matching
   `GATEWAY_KEY_ID`. Do not print that file.
3. Overlap the old and new HMAC identities in the Worker secret:

   ```bash
   cd backend/license-worker
   printf '%s' '{"<OLD_GATEWAY_ID>":"<OLD_HMAC_SECRET>","<NEW_GATEWAY_ID>":"<NEW_HMAC_SECRET>"}' | npx wrangler secret put GATEWAY_HMAC_SECRETS
   ```

4. Deploy the new Worker public pin and key id while preserving only the
   separately authorized cloud-test state:

   ```bash
   npx wrangler deploy src/worker.js \
     --var "GATEWAY_PUBLIC_JWK:<NEW_ONE_LINE_PUBLIC_JWK>" \
     --var "GATEWAY_KEY_ID:<NEW_GATEWAY_KEY_ID>" \
     --var "CLOUD_TEST_ENABLED:<AUTHORIZED_CLOUD_TEST_ENABLED>"
   ```

5. Replace the complete environment/private-JWK file and verify the restarted
   service with redacted status and logs:

   ```bash
   install -o root -g pureautolike-gateway -m 0600 <NEW_GATEWAY_ENV_FILE> /etc/pureautolike/gateway.env
   systemctl daemon-reload
   systemctl restart pureautolike-gateway
   systemctl status pureautolike-gateway --no-pager
   journalctl -u pureautolike-gateway --since '-10 minutes' --no-pager
   ```

6. Require every owner test device to reauthenticate and upload a fresh envelope
   pinned to the new key. Old-key envelopes must fail with
   `GATEWAY_KEY_MISMATCH`. Verify every retained cloud session reports the new
   key id before securely deleting the retired private JWK.
7. After signed lease/heartbeat health is verified on `<NEW_GATEWAY_ID>`, remove
   the retired HMAC mapping:

   ```bash
   printf '%s' '{"<NEW_GATEWAY_ID>":"<NEW_HMAC_SECRET>"}' | npx wrangler secret put GATEWAY_HMAC_SECRETS
   ```

Never reuse either HMAC secret as an encryption key.

## 8. Destructive deletion verification

From the owner test device, choose **Delete and disconnect**. Verify the public
cloud status reports `configured=false`, then use account-scoped count queries.
Every result below must be zero before declaring deletion complete:

```bash
cd backend/license-worker
npx wrangler d1 execute pureautolike_license --remote --command "SELECT (SELECT COUNT(*) FROM bridge_cloud_sessions WHERE account_id='<ACCOUNT_ID>') AS sessions, (SELECT COUNT(*) FROM bridge_gateway_leases WHERE account_id='<ACCOUNT_ID>') AS leases, (SELECT COUNT(*) FROM bridge_delivery_queue WHERE account_id='<ACCOUNT_ID>') AS queue, (SELECT COUNT(*) FROM bridge_media_transfers WHERE account_id='<ACCOUNT_ID>') AS media, (SELECT COUNT(*) FROM bridge_sync_state WHERE account_id='<ACCOUNT_ID>') AS sync_state;"
```

Also confirm the service has no connector for `<ACCOUNT_ID>` using redacted
gateway state. Do not put the account's Pure credential in the query or logs.

## Protocol fixture stop gate

Stop here. Keep `CLOUD_TEST_ENABLED = "false"`, keep the gateway disabled, and
do not enable import or Telegram-to-Pure sends. A human-reviewed set of sanitized
real protocol fixtures must first prove all four operations:

- conversation list pagination and stable identifiers;
- chronological history import, duplicate handling, and oldest-page completion;
- WebSocket reconnect/resume ordering without leaked credentials or bodies;
- credential refresh and explicit reauthentication behavior.

Run the sanitizer/contract locally and require it to pass:

```bash
node tests/pure-protocol-fixtures.mjs
npm run audit:clean
```

No allowlist entry, service enablement, import, or send is permitted merely
because synthetic tests pass. The gate opens only after sanitized
list/history/WebSocket/refresh fixtures have been reviewed and the owner
explicitly authorizes the controlled test.
