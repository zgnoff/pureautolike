import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {dirname, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = path => readFile(resolve(root, path), 'utf8');
const privacy = await read('PRIVACY.md');
const backendDocs = await read('docs/beta-billing-backend.md');
const gatewayRunbook = await read('docs/cloud-gateway-runbook.md');

assert.match(privacy, /encrypted Pure credential envelope/, 'privacy policy must disclose encrypted Pure credential processing');
assert.match(privacy, /does not ask for or receive the user’s Pure password/, 'privacy policy must state that Pure passwords are not processed');
assert.match(privacy, /shared server IP/, 'privacy policy must disclose the shared-IP Pure account risk');
assert.match(privacy, /owner-operated test accounts/, 'privacy policy must limit the cloud test to owner-operated accounts');
assert.match(privacy, /fixed 24-hour expiry/, 'privacy policy must disclose the future command queue retention limit');

assert.match(backendDocs, /CLOUD_TEST_ENABLED = "false"/, 'backend docs must keep cloud test mode disabled by default');
assert.match(backendDocs, /known deployed database, which predates all cloud gateway tables/, 'backend docs must identify the known pre-cloud deployment shape');
assert.match(backendDocs, /Only an intermediate installation/, 'backend docs must scope migration work to intermediate cloud schemas');

assert.match(gatewayRunbook, /owner-operated test accounts/, 'runbook must limit shared-IP risk to owner-operated test accounts');
assert.match(gatewayRunbook, /All controlled-test accounts share the gateway's server IP/, 'runbook must disclose the shared gateway IP risk');
assert.match(gatewayRunbook, /CLOUD_TEST_ENABLED = "false"/, 'runbook must keep cloud test mode disabled by default');
assert.match(gatewayRunbook, /fixed 24-hour expiry/, 'runbook must document the future queue expiry');
assert.match(gatewayRunbook, /GATEWAY_PUBLIC_JWK[\s\S]*public pin may be distributed/, 'runbook must identify the distributable public pin');
assert.match(gatewayRunbook, /GATEWAY_PRIVATE_JWK[\s\S]*private JWK must never leave secret storage/, 'runbook must separate private key secret storage');
function assertSafeHmacSecretCommands(source, expectedCount = 3) {
  const lines = source
    .split('\n')
    .map(line => line.trim())
    .filter(line => line.includes('wrangler secret put GATEWAY_HMAC_SECRETS'));
  assert.equal(lines.length, expectedCount, 'runbook must contain the expected HMAC secret updates');
  for (const line of lines) {
    assert.match(
      line,
      /^npx wrangler secret put GATEWAY_HMAC_SECRETS < "\$[A-Z_]*GATEWAY_HMAC_JSON_FILE"$/,
      'every HMAC secret update must use quoted file redirection only'
    );
    const index = source.indexOf(line);
    const context = source.slice(Math.max(0, index - 600), index + line.length + 200);
    assert.doesNotMatch(context, /['"]?\{[^{}\n]*:[^{}\n]*\}['"]?/, 'HMAC secret context must not contain any literal JSON mapping');
  }
  assert.doesNotMatch(source, /(?:printf|echo)[^\n]*GATEWAY_HMAC_SECRETS/i, 'runbook must not pass HMAC mappings through printf or echo');
  assert.doesNotMatch(source, /(?:-d|--data|--arg)\s+[^\n]*GATEWAY_HMAC_SECRETS/i, 'runbook must not place HMAC mappings in command arguments');
  assert.doesNotMatch(source, /[A-Z_]*GATEWAY_HMAC(?:_JSON)?(?:_FILE)?\s*=\s*['"]?\{/, 'runbook must not assign inline HMAC JSON');
}
assertSafeHmacSecretCommands(gatewayRunbook);
for (const unsafe of [
  `printf '%s' '{"gateway-1":"literal-value"}' | npx wrangler secret put GATEWAY_HMAC_SECRETS`,
  `echo '{"gateway-1":"literal-value"}' | npx wrangler secret put GATEWAY_HMAC_SECRETS`,
  `npx wrangler secret put GATEWAY_HMAC_SECRETS -d '{"gateway-1":"literal-value"}'`,
  `GATEWAY_HMAC_JSON='{"gateway-1":"literal-value"}'\nnpx wrangler secret put GATEWAY_HMAC_SECRETS < "$GATEWAY_HMAC_JSON_FILE"`,
  `npx wrangler secret put GATEWAY_HMAC_SECRETS <<< '{"gateway-1":"literal-value"}'`
]) assert.throws(() => assertSafeHmacSecretCommands(unsafe, 1), 'HMAC scanner must reject every inline JSON transport shape');
assert.match(gatewayRunbook, /known deployed database predates every cloud table/, 'runbook must identify the known pre-cloud D1 shape');
assert.match(gatewayRunbook, /Only an intermediate installation needs a migration/, 'runbook must condition migration on an intermediate cloud schema');
assert.match(gatewayRunbook, /npx wrangler d1 execute pureautolike_license --remote --file schema\.sql/, 'runbook must apply the complete schema to the known pre-cloud database');
assert.match(gatewayRunbook, /PRAGMA table_info\('bridge_cloud_sessions'\)/, 'runbook must inspect intermediate cloud session columns');
assert.match(gatewayRunbook, /mounted encrypted filesystem[\s\S]*findmnt --target \/var\/lib\/pureautolike-gateway\/spool/, 'runbook must verify the encrypted spool mount prerequisite');
assert.match(gatewayRunbook, /ReadWritePaths=\/var\/lib\/pureautolike-gateway\/spool/, 'runbook must preserve a single writable systemd spool');
assert.match(gatewayRunbook, /chmod 600 \/etc\/pureautolike\/gateway\.env/, 'runbook must restrict the systemd environment file');
assert.match(gatewayRunbook, /systemctl is-active pureautolike-gateway/, 'runbook must include a service health check');
assert.match(gatewayRunbook, /systemctl stop pureautolike-gateway/, 'runbook must include the kill switch');
assert.match(gatewayRunbook, /ln -sfn \/opt\/pureautolike\/releases\/<PREVIOUS_RELEASE>\/backend\/pure-gateway \/opt\/pureautolike\/backend\/pure-gateway\.next/, 'rollback must restore the previous release symlink');
assert.match(gatewayRunbook, /install -o root -g pureautolike-gateway -m 0600 <ROLLBACK_GATEWAY_ENV_FILE> \/etc\/pureautolike\/gateway\.env/, 'rollback must replace the environment and private JWK');
for (const fileVariable of [
  'GATEWAY_HMAC_JSON_FILE',
  'OVERLAP_GATEWAY_HMAC_JSON_FILE',
  'RETIRED_GATEWAY_HMAC_JSON_FILE'
]) {
  assert.ok(gatewayRunbook.includes(`chmod 600 "$${fileVariable}"`), `runbook must chmod ${fileVariable} to 600`);
  assert.ok(gatewayRunbook.includes(`test "$(stat -c '%a' "$${fileVariable}")" = "600"`), `runbook must verify ${fileVariable} mode 600`);
}
const publicJwkVarLines = gatewayRunbook
  .split('\n')
  .map(line => line.trim())
  .filter(line => line.startsWith('--var "GATEWAY_PUBLIC_JWK:'));
assert.equal(publicJwkVarLines.length, 2, 'rollback and rotation must each deploy a public JWK from a file');
for (const line of publicJwkVarLines) {
  assert.match(
    line,
    /^--var "GATEWAY_PUBLIC_JWK:\$\(tr -d '\\n' < "\$[A-Z_]*GATEWAY_PUBLIC_JWK_FILE"\)" \\$/,
    'public JWK vars must use quoted substitution from a named file'
  );
}
for (const fileVariable of ['ROLLBACK_GATEWAY_PUBLIC_JWK_FILE', 'NEW_GATEWAY_PUBLIC_JWK_FILE']) {
  assert.ok(gatewayRunbook.includes(`test -f "$${fileVariable}"`), `runbook must verify ${fileVariable} exists`);
}
assert.match(gatewayRunbook, /test "<PROTOCOL_FIXTURE_GATE>" = "open"[\s\S]*test "<AUTHORIZED_CONTROLLED_DEPLOYMENT>" = "yes"/, 'rotation restart must have protocol-gate and deployment-authorization guards');
assert.match(gatewayRunbook, /Before that point, do not restart the gateway/, 'rotation must forbid restart before the protocol gate opens');

for (const command of [
  'systemctl daemon-reload',
  'systemctl restart pureautolike-gateway',
  'systemctl status pureautolike-gateway --no-pager',
  "journalctl -u pureautolike-gateway --since '-10 minutes' --no-pager"
]) assert.ok(gatewayRunbook.includes(command), `rotation/rollback runbook missing exact service command: ${command}`);

for (const fixture of [
  'conversation list pagination and stable identifiers',
  'chronological history import, duplicate handling, and oldest-page completion',
  'WebSocket reconnect/resume ordering',
  'credential refresh and explicit reauthentication behavior'
]) assert.ok(gatewayRunbook.includes(fixture), `protocol stop gate missing exact fixture contract: ${fixture}`);

assert.match(gatewayRunbook, /Destructive deletion verification/, 'runbook must verify destructive cloud deletion');
assert.doesNotMatch(gatewayRunbook, /Bearer\s+[A-Za-z0-9._-]{16,}/i, 'runbook must not contain a live-looking bearer credential');
assert.doesNotMatch(gatewayRunbook, /GATEWAY_HMAC_SECRET=[^<\n][^\n]*/i, 'runbook must use placeholders for HMAC secrets');
assert.doesNotMatch(gatewayRunbook, /"d"\s*:\s*"[A-Za-z0-9_-]{20,}"/, 'runbook must not contain private JWK d material');
assert.doesNotMatch(gatewayRunbook, /\b\d{8,10}:[A-Za-z0-9_-]{30,}\b/, 'runbook must not contain a Telegram bot token');
assert.doesNotMatch(gatewayRunbook, /(?:CLOUDFLARE_API_TOKEN|CF_API_TOKEN|API_TOKEN|TELEGRAM_BOT_TOKEN)\s*=\s*(?!<)[^\s<]+/i, 'runbook must not contain a live-looking API token assignment');
assert.doesNotMatch(gatewayRunbook, /GATEWAY_PRIVATE_JWK=(?!<)[^\n]+/, 'runbook must use a placeholder for the private JWK');
assert.doesNotMatch(gatewayRunbook, /['"]\{[^}\n]*(?:GATEWAY_ID|HMAC_SECRET)[^}\n]*\}['"]/, 'runbook must not contain literal HMAC JSON mappings');
assert.doesNotMatch(gatewayRunbook, /--var "GATEWAY_PUBLIC_JWK:<[^>]+>"/, 'runbook must not place an inline public JWK placeholder in argv');
assert.doesNotMatch(gatewayRunbook, /--var "GATEWAY_PUBLIC_JWK:\{/, 'runbook must not place inline public JWK JSON in argv');

console.log('cloud gateway documentation contract passed');
