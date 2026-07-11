# Pure Telegram Bridge Phase 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver a working inbound MVP that pairs one extension device with the hosted Telegram bot and mirrors Pure matches/messages into one private Telegram topic per Pure conversation without sending Pure bearer tokens or raw Pure conversation IDs to the relay.

**Architecture:** Extend the existing Cloudflare Worker/D1 backend with device pairing, challenge-based sessions, Telegram webhook handling, topic mappings, and an authenticated inbound event endpoint. Add a focused cross-browser background helper that owns device keys and relay requests, while the existing content detector supplies normalized events through the current runtime-message boundary. Keep the current user-owned Telegram bot integration working during migration.

**Tech Stack:** JavaScript ES2022, Chrome/Firefox/Safari WebExtensions, Web Crypto ECDSA/ECDH P-256, IndexedDB, Cloudflare Workers, Cloudflare D1, Telegram Bot API private-chat topics, Node.js fixture tests.

## Global Constraints

- Pure bearer tokens and raw authorization headers must never leave `src/page-bridge.js`.
- Raw Pure conversation IDs remain in extension-local storage and are replaced with opaque UUID mapping IDs before relay requests.
- Successfully relayed message bodies must not be stored in D1 or backend logs.
- Phase 1 is inbound only: Pure-to-Telegram matches and text messages; Telegram-to-Pure replies and the encrypted 24-hour queue are Phase 2.
- Existing local extension features and the legacy user-owned Telegram bot flow must remain functional when the hosted relay is unavailable.
- Pairing codes expire after 10 minutes, are single-use, and pairing a new device revokes the previous active device for that Telegram account.
- Device API sessions expire after 10 minutes and require an ECDSA P-256 challenge signature to renew.
- Telegram webhook requests require `X-Telegram-Bot-Api-Secret-Token` equality with a Worker secret.
- No new runtime npm dependencies are added to the extension.
- All code changes follow TDD and every task ends with a focused commit.

---

## File Structure

### Backend

- `backend/license-worker/src/worker.js` — top-level routing; delegates `/v1/telegram/*` and `/v1/device/*` to the bridge module before existing license routes.
- `backend/license-worker/src/telegram-bridge.js` — pairing, device challenge/session, Telegram webhook, topic delivery, validation, hashing, and Telegram API adapter.
- `backend/license-worker/schema.sql` — bridge accounts, devices, pairing codes, challenges, sessions, Telegram links, topic mappings, and dedupe rows.
- `backend/license-worker/wrangler.toml.example` — documented non-secret bot username and secret names.

### Extension

- `src/telegram-bridge-client.js` — isolated cross-browser bridge client, device key persistence, sessions, pairing, local conversation mappings, and event relay.
- `src/background-entry.js` — Chromium service-worker entry that loads the bridge client before the existing background runtime.
- `src/background.js` — instantiates the bridge client and exposes runtime message handlers without owning cryptographic details.
- `src/content.js` — includes `threadId`, event timestamp, and message kind in sanitized event messages.
- `popup.html`, `src/popup.js`, `src/popup.css` — hosted bridge connect/status/disconnect controls while retaining legacy Telegram controls.
- `manifest.json`, `manifests/*.json`, `tools/build.mjs` — load/copy the background bridge module consistently on all targets.

### Tests and docs

- `tests/helpers/fake-d1.mjs` — deterministic D1 double for bridge endpoint tests.
- `tests/telegram-bridge-worker.mjs` — backend pairing, session, webhook, topic, dedupe, and privacy tests.
- `tests/telegram-bridge-client.mjs` — extension client key/session/mapping/event tests.
- `tests/background-fixtures.mjs`, `tests/engagement-fixtures.mjs`, `tests/validate-extension.mjs` — integration contract updates.
- `PRIVACY.md`, `docs/beta-billing-backend.md` — transient message processing and deployment instructions.

---

### Task 1: Add D1 Bridge Schema and Validation

**Files:**
- Modify: `backend/license-worker/schema.sql`
- Modify: `tests/validate-extension.mjs`
- Create: `tests/telegram-bridge-worker.mjs`
- Modify: `package.json`

**Interfaces:**
- Produces tables: `bridge_accounts`, `bridge_devices`, `bridge_pairing_codes`, `bridge_challenges`, `bridge_sessions`, `bridge_telegram_links`, `bridge_conversation_topics`, `bridge_event_dedupe`.
- Later tasks rely on exact primary keys and column names introduced here.

- [ ] **Step 1: Add a failing schema contract test**

Append this table contract to `tests/telegram-bridge-worker.mjs`:

```js
import {readFile} from 'node:fs/promises';
import {dirname, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const schema = await readFile(resolve(root, 'backend/license-worker/schema.sql'), 'utf8');

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const bridgeTables = [
  'bridge_accounts',
  'bridge_devices',
  'bridge_pairing_codes',
  'bridge_challenges',
  'bridge_sessions',
  'bridge_telegram_links',
  'bridge_conversation_topics',
  'bridge_event_dedupe'
];

for (const table of bridgeTables) {
  assert(schema.includes(`CREATE TABLE IF NOT EXISTS ${table}`), `missing ${table}`);
}
assert(schema.includes('signing_public_jwk TEXT NOT NULL'), 'device signing key missing');
assert(schema.includes('encryption_public_jwk TEXT NOT NULL'), 'device encryption key missing');
assert(schema.includes('telegram_thread_id TEXT NOT NULL'), 'topic mapping missing');
assert(!schema.includes('message_body'), 'schema must not persist relayed message bodies');
```

- [ ] **Step 2: Run the schema test and verify failure**

Run: `node tests/telegram-bridge-worker.mjs`

Expected: FAIL with `missing bridge_accounts`.

- [ ] **Step 3: Add the complete bridge schema**

Append the following definitions to `backend/license-worker/schema.sql`:

```sql
CREATE TABLE IF NOT EXISTS bridge_accounts (
  id TEXT PRIMARY KEY,
  status TEXT NOT NULL DEFAULT 'active',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS bridge_devices (
  id TEXT PRIMARY KEY,
  account_id TEXT,
  signing_public_jwk TEXT NOT NULL,
  encryption_public_jwk TEXT NOT NULL,
  extension_version TEXT NOT NULL DEFAULT '',
  release_channel TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'pairing',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_seen_at TEXT,
  revoked_at TEXT,
  FOREIGN KEY (account_id) REFERENCES bridge_accounts(id)
);

CREATE TABLE IF NOT EXISTS bridge_pairing_codes (
  id TEXT PRIMARY KEY,
  device_id TEXT NOT NULL,
  code_hash TEXT NOT NULL UNIQUE,
  poll_secret_hash TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  expires_at TEXT NOT NULL,
  consumed_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (device_id) REFERENCES bridge_devices(id)
);

CREATE TABLE IF NOT EXISTS bridge_challenges (
  id TEXT PRIMARY KEY,
  device_id TEXT NOT NULL,
  nonce_hash TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  consumed_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (device_id) REFERENCES bridge_devices(id)
);

CREATE TABLE IF NOT EXISTS bridge_sessions (
  id TEXT PRIMARY KEY,
  device_id TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TEXT NOT NULL,
  revoked_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (device_id) REFERENCES bridge_devices(id)
);

CREATE TABLE IF NOT EXISTS bridge_telegram_links (
  account_id TEXT PRIMARY KEY,
  telegram_user_id TEXT NOT NULL UNIQUE,
  telegram_chat_id TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'active',
  paired_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_seen_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (account_id) REFERENCES bridge_accounts(id)
);

CREATE TABLE IF NOT EXISTS bridge_conversation_topics (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  mapping_id TEXT NOT NULL,
  telegram_thread_id TEXT NOT NULL,
  display_label TEXT NOT NULL DEFAULT '',
  state TEXT NOT NULL DEFAULT 'active',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_event_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (account_id, mapping_id),
  UNIQUE (account_id, telegram_thread_id),
  FOREIGN KEY (account_id) REFERENCES bridge_accounts(id)
);

CREATE TABLE IF NOT EXISTS bridge_event_dedupe (
  account_id TEXT NOT NULL,
  event_hash TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (account_id, event_hash),
  FOREIGN KEY (account_id) REFERENCES bridge_accounts(id)
);

CREATE INDEX IF NOT EXISTS idx_bridge_devices_account_status ON bridge_devices(account_id, status);
CREATE INDEX IF NOT EXISTS idx_bridge_pairing_expiry ON bridge_pairing_codes(status, expires_at);
CREATE INDEX IF NOT EXISTS idx_bridge_sessions_token ON bridge_sessions(token_hash, expires_at);
CREATE INDEX IF NOT EXISTS idx_bridge_topics_mapping ON bridge_conversation_topics(account_id, mapping_id);
CREATE INDEX IF NOT EXISTS idx_bridge_dedupe_created ON bridge_event_dedupe(created_at);
```

- [ ] **Step 4: Wire the new test into validation**

Change the root `package.json` validate script to run the new test after the existing background fixtures:

```json
"validate": "node tests/validate-extension.mjs && node tests/engagement-fixtures.mjs && node tests/background-fixtures.mjs && node tests/telegram-bridge-worker.mjs && node tests/photo-opener-fixtures.mjs && node tests/runner-fixtures.mjs"
```

Extend `tests/validate-extension.mjs` so `bridgeTables` are asserted separately from the existing license tables.

- [ ] **Step 5: Run focused validation**

Run: `node tests/telegram-bridge-worker.mjs && node tests/validate-extension.mjs`

Expected: both print their pass messages and exit `0`.

- [ ] **Step 6: Commit**

```bash
git add backend/license-worker/schema.sql tests/telegram-bridge-worker.mjs tests/validate-extension.mjs package.json
git commit -m "feat: add Telegram bridge data model"
```

---

### Task 2: Add Relay Routing, Validation, and Telegram Adapter

**Files:**
- Create: `backend/license-worker/src/telegram-bridge.js`
- Modify: `backend/license-worker/src/worker.js`
- Create: `tests/helpers/fake-d1.mjs`
- Modify: `tests/telegram-bridge-worker.mjs`
- Modify: `backend/license-worker/package.json`

**Interfaces:**
- Produces: `createTelegramBridge({fetchImpl, now, randomUUID})`.
- Produces handler: `handle(request, env)` returning `Response | null`; `null` means the legacy worker should continue routing.
- Produces helpers: `sanitizeTopicTitle(value)`, `sha256(value)`, `validatePublicJwk(value, use)`.

- [ ] **Step 1: Write failing primitive tests**

Add to `tests/telegram-bridge-worker.mjs`:

```js
import {
  createTelegramBridge,
  sanitizeTopicTitle,
  validatePublicJwk
} from '../backend/license-worker/src/telegram-bridge.js';

assert(sanitizeTopicTitle('  Аня\n28  ') === 'Аня 28', 'topic title must be single-line');
assert(sanitizeTopicTitle('x'.repeat(200)).length === 128, 'topic title must be bounded');
assert(validatePublicJwk({kty: 'EC', crv: 'P-256', x: 'a', y: 'b'}, 'sign'), 'P-256 signing JWK must pass');
assert(!validatePublicJwk({kty: 'RSA', n: 'a'}, 'sign'), 'non-EC JWK must fail');

const notBridge = await createTelegramBridge({fetchImpl: fetch}).handle(
  new Request('https://worker.example/v1/license/check', {method: 'POST'}),
  {}
);
assert(notBridge === null, 'non-bridge route must fall through');
```

- [ ] **Step 2: Run and verify module-not-found failure**

Run: `node tests/telegram-bridge-worker.mjs`

Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `telegram-bridge.js`.

- [ ] **Step 3: Implement the module boundary and pure helpers**

Create `backend/license-worker/src/telegram-bridge.js` with this public structure:

```js
const JSON_HEADERS = {'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store'};
const BRIDGE_PREFIXES = ['/v1/telegram/', '/v1/device/'];

export function sanitizeTopicTitle(value) {
  const title = String(value || '').replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim();
  return (title || 'Pure chat').slice(0, 128);
}

export function validatePublicJwk(value) {
  return !!(value && value.kty === 'EC' && value.crv === 'P-256' && value.x && value.y);
}

export async function sha256(value) {
  const bytes = new TextEncoder().encode(String(value));
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}

function json(payload, status = 200) {
  return new Response(JSON.stringify(payload), {status, headers: JSON_HEADERS});
}

export function createTelegramBridge(options = {}) {
  const fetchImpl = options.fetchImpl || fetch;
  const now = options.now || (() => new Date());
  const randomUUID = options.randomUUID || (() => crypto.randomUUID());

  return {
    async handle(request, env) {
      const url = new URL(request.url);
      if (!BRIDGE_PREFIXES.some(prefix => url.pathname.startsWith(prefix))) return null;
      if (!env.DB) return json({ok: false, code: 'DB_UNAVAILABLE'}, 503);
      return json({ok: false, code: 'NOT_FOUND'}, 404);
    },
    fetchImpl,
    now,
    randomUUID
  };
}
```

- [ ] **Step 4: Delegate bridge routes from the existing worker**

At the top of `worker.js`, import and construct the bridge:

```js
import {createTelegramBridge} from './telegram-bridge.js';

const telegramBridge = createTelegramBridge();
```

At the start of the `try` block in `fetch`:

```js
const bridgeResponse = await telegramBridge.handle(request, env);
if (bridgeResponse) return bridgeResponse;
```

Do not change existing license, privacy, checkout, or webhook behavior.

- [ ] **Step 5: Add a reusable D1 test double**

Create `tests/helpers/fake-d1.mjs` exporting `createFakeD1(seed = {})`. It must record SQL and bound arguments and expose deterministic handlers by SQL substring:

```js
export function createFakeD1() {
  const calls = [];
  const handlers = [];
  return {
    calls,
    when(pattern, handler) {
      handlers.push({pattern, handler});
    },
    prepare(sql) {
      let params = [];
      const execute = method => {
        calls.push({sql, params, method});
        const match = handlers.find(item => sql.includes(item.pattern));
        return match ? match.handler({sql, params, method}) : method === 'all' ? {results: []} : null;
      };
      return {
        bind(...values) { params = values; return this; },
        first() { return Promise.resolve(execute('first')); },
        all() { return Promise.resolve(execute('all')); },
        run() { return Promise.resolve(execute('run') || {success: true}); }
      };
    },
    batch(statements) {
      return Promise.all(statements.map(statement => statement.run()));
    }
  };
}
```

- [ ] **Step 6: Validate syntax and routing**

Run: `node --check backend/license-worker/src/telegram-bridge.js && node --check backend/license-worker/src/worker.js && node tests/telegram-bridge-worker.mjs`

Expected: all exit `0`.

- [ ] **Step 7: Update backend check script and commit**

Set:

```json
"check": "node --check src/worker.js && node --check src/telegram-bridge.js"
```

Then commit:

```bash
git add backend/license-worker/src/telegram-bridge.js backend/license-worker/src/worker.js backend/license-worker/package.json tests/helpers/fake-d1.mjs tests/telegram-bridge-worker.mjs
git commit -m "feat: add Telegram bridge worker boundary"
```

---

### Task 3: Implement Device Pairing and Challenge Sessions

**Files:**
- Modify: `backend/license-worker/src/telegram-bridge.js`
- Modify: `tests/telegram-bridge-worker.mjs`
- Modify: `backend/license-worker/wrangler.toml.example`

**Interfaces:**
- `POST /v1/telegram/pairing/start` consumes public JWKs, extension version, and release channel.
- `GET /v1/telegram/pairing/status/:id` consumes `Authorization: Bearer <poll-secret>`.
- `POST /v1/device/challenge` consumes `{device_id}`.
- `POST /v1/device/session` consumes `{device_id, challenge_id, nonce, signature}`.
- Authenticated endpoints consume `Authorization: Bearer <10-minute-session-token>`.

- [ ] **Step 1: Write failing pairing endpoint tests**

Use fixed `now` and `randomUUID` dependencies and assert:

```js
const bridge = createTelegramBridge({
  fetchImpl: async () => new Response('{}'),
  now: () => new Date('2026-07-12T12:00:00.000Z'),
  randomUUID: (() => { let n = 0; return () => `uuid-${++n}`; })()
});

const startResponse = await bridge.handle(new Request('https://worker.example/v1/telegram/pairing/start', {
  method: 'POST',
  headers: {'Content-Type': 'application/json'},
  body: JSON.stringify({
    signing_public_jwk: {kty: 'EC', crv: 'P-256', x: 'sx', y: 'sy'},
    encryption_public_jwk: {kty: 'EC', crv: 'P-256', x: 'ex', y: 'ey'},
    extension_version: '0.1.32',
    release_channel: 'chrome-web-store'
  })
}), {DB: fakeDb, TELEGRAM_BOT_USERNAME: 'PureAutoLikeBot'});

const started = await startResponse.json();
assert(startResponse.status === 201, 'pairing start must return 201');
assert(started.bot_url.startsWith('https://t.me/PureAutoLikeBot?start='), 'bot URL missing');
assert(started.poll_secret, 'poll secret missing');
assert(!JSON.stringify(fakeDb.calls).includes(started.poll_secret), 'raw poll secret must not reach D1');
```

Add rejection tests for invalid JSON, non-P-256 JWKs, missing bot username, expired codes, a wrong poll secret, and reused pairing codes.

- [ ] **Step 2: Run and verify `NOT_FOUND` failure**

Run: `node tests/telegram-bridge-worker.mjs`

Expected: FAIL because pairing start returns `404 NOT_FOUND`.

- [ ] **Step 3: Implement pairing issuance and status**

Implement bounded JSON parsing (`16 KiB` maximum), base64url random secrets, SHA-256-at-rest token hashing, 10-minute expiry, and these stable responses:

```js
// pairing start, HTTP 201
{
  ok: true,
  pairing_id: 'pair_uuid-1',
  poll_secret: '<raw single-client secret>',
  bot_url: 'https://t.me/PureAutoLikeBot?start=<code>',
  expires_at: '2026-07-12T12:10:00.000Z'
}

// pending status
{ok: true, status: 'pending', expires_at: '...'}

// paired status
{ok: true, status: 'paired', device_id: 'device_uuid-2'}
```

Persist only hashes of the pairing code and poll secret. Never return public keys from status responses.

- [ ] **Step 4: Write failing challenge/session cryptography tests**

Generate a real P-256 test key with Web Crypto, insert the public JWK through the fake DB, sign the canonical bytes, and assert session creation:

```js
const canonical = `${deviceId}.${challengeId}.${nonce}`;
const signature = await crypto.subtle.sign(
  {name: 'ECDSA', hash: 'SHA-256'},
  privateKey,
  new TextEncoder().encode(canonical)
);
```

Also assert failures for an expired challenge, reused challenge, revoked device, malformed signature, and wrong device key.

- [ ] **Step 5: Implement challenge/session endpoints**

Use this canonical signature contract exactly:

```text
<device_id>.<challenge_id>.<raw_nonce>
```

Challenges expire after 2 minutes and are consumed atomically. Sessions expire after 10 minutes. Persist only nonce and token hashes. On successful session creation, update `bridge_devices.last_seen_at`.

- [ ] **Step 6: Add authenticated-session helper tests**

Expose no token details publicly. Internally add:

```js
async function requireDeviceSession(request, env) {
  // returns {accountId, deviceId, telegramChatId} or throws BridgeError
}
```

Test absent, expired, revoked, and valid bearer sessions.

- [ ] **Step 7: Document Worker configuration**

Add to `wrangler.toml.example`:

```toml
TELEGRAM_BOT_USERNAME = "PureAutoLikeBot"

# Configure as Wrangler secrets, never plaintext vars:
# TELEGRAM_BOT_TOKEN
# TELEGRAM_WEBHOOK_SECRET
```

- [ ] **Step 8: Run tests and commit**

Run: `node tests/telegram-bridge-worker.mjs && npm --prefix backend/license-worker run check`

Expected: PASS.

```bash
git add backend/license-worker/src/telegram-bridge.js backend/license-worker/wrangler.toml.example tests/telegram-bridge-worker.mjs
git commit -m "feat: add secure Telegram device pairing"
```

---

### Task 4: Implement Telegram Webhook, Pair Completion, and Topic Delivery

**Files:**
- Modify: `backend/license-worker/src/telegram-bridge.js`
- Modify: `tests/telegram-bridge-worker.mjs`

**Interfaces:**
- `POST /v1/telegram/webhook` consumes Telegram updates with the configured secret header.
- `POST /v1/telegram/events` consumes an authenticated bounded event.
- Telegram adapter methods: `createForumTopic(chatId, title)`, `sendMessage(chatId, threadId, text)`.

- [ ] **Step 1: Write failing webhook pairing tests**

Test a private `/start <code>` update:

```js
const update = {
  update_id: 100,
  message: {
    message_id: 7,
    from: {id: 12345, is_bot: false, first_name: 'Ivan'},
    chat: {id: 12345, type: 'private'},
    date: 1783857600,
    text: '/start ABCDEF12'
  }
};
```

Assert that the handler rejects a missing/wrong secret, consumes a valid pairing code once, creates an account/link, marks the new device active, revokes any previously active device for Telegram user `12345`, and sends a Telegram confirmation.

- [ ] **Step 2: Implement webhook authentication and pair completion**

Validate the header using a constant-time byte comparison. Accept only private-chat `/start` messages for pairing. Apply account/device/link updates in one D1 batch. A repeated Telegram update must return `200 {ok:true, duplicate:true}` without creating another account.

- [ ] **Step 3: Write failing hosted event tests**

Submit this authenticated event twice:

```js
const event = {
  mapping_id: 'map_550e8400-e29b-41d4-a716-446655440000',
  event_id: 'message:chat.thread-2:message-9',
  kind: 'message',
  label: 'Аня · 28',
  title: 'Новое сообщение',
  body: 'Новое сообщение в Pure',
  text: 'Привет',
  timestamp: '2026-07-12T12:05:00.000Z'
};
```

Assert that the first call creates one topic and sends one message, the duplicate sends nothing, a second event for the same `mapping_id` reuses the topic, and no SQL bind contains `Привет`.

- [ ] **Step 4: Implement Telegram Bot API adapter**

Use only server-side `env.TELEGRAM_BOT_TOKEN`:

```js
async function telegramRequest(env, method, payload, fetchImpl) {
  const response = await fetchImpl(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/${method}`, {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify(payload)
  });
  const body = await response.json().catch(() => null);
  if (!response.ok || !body?.ok) throw telegramError(response.status, body);
  return body.result;
}
```

For a missing mapping, call `createForumTopic` with `{chat_id, name}` and persist the returned `message_thread_id`. Send content with `sendMessage` and the mapped `message_thread_id`. Respect Telegram `retry_after` and return HTTP `429` with a bounded `retry_after` value to the extension.

- [ ] **Step 5: Implement event validation and privacy behavior**

Accept only `match` and `message` in Phase 1. Enforce:

```js
const LIMITS = {
  mappingId: 80,
  eventId: 220,
  label: 128,
  title: 128,
  body: 240,
  text: 4096
};
```

Hash `event_id` before inserting into `bridge_event_dedupe`. Do not insert body/text/title into D1. Return `{ok:true, duplicate, thread_id}`.

- [ ] **Step 6: Run tests and commit**

Run: `node tests/telegram-bridge-worker.mjs`

Expected: webhook, pairing, topic reuse, dedupe, rate-limit, and privacy assertions pass.

```bash
git add backend/license-worker/src/telegram-bridge.js tests/telegram-bridge-worker.mjs
git commit -m "feat: relay Pure events into Telegram topics"
```

---

### Task 5: Add Cross-Browser Extension Bridge Client

**Files:**
- Create: `src/telegram-bridge-client.js`
- Create: `src/background-entry.js`
- Modify: `src/background.js`
- Modify: `manifest.json`
- Modify: `manifests/chromium.json`
- Modify: `manifests/firefox.json`
- Modify: `manifests/safari.json`
- Modify: `tools/build.mjs`
- Create: `tests/telegram-bridge-client.mjs`
- Modify: `tests/background-fixtures.mjs`
- Modify: `tests/validate-extension.mjs`
- Modify: `package.json`

**Interfaces:**
- Global factory: `globalThis.PalTelegramBridge.createClient(options)`.
- Client methods: `startPairing()`, `pairingStatus()`, `status()`, `disconnect()`, `relayEvent(signal)`.
- Background messages: `pal-bridge-pair-start`, `pal-bridge-pair-status`, `pal-bridge-status`, `pal-bridge-disconnect`.

- [ ] **Step 1: Write failing client contract tests**

Load `src/telegram-bridge-client.js` in a VM and assert:

```js
assert(context.PalTelegramBridge, 'bridge client global missing');
assert(typeof context.PalTelegramBridge.createClient === 'function', 'client factory missing');

const client = context.PalTelegramBridge.createClient({
  endpoint: 'https://worker.example',
  fetchImpl: fakeFetch,
  cryptoImpl: webcrypto,
  keyStore: memoryKeyStore,
  storage: memoryStorage,
  now: () => Date.parse('2026-07-12T12:00:00.000Z')
});

const pairing = await client.startPairing({version: '0.1.32', channel: 'chrome-web-store'});
assert(pairing.botUrl.includes('https://t.me/'), 'pairing bot URL missing');
assert(memoryKeyStore.has('signing-private'), 'signing key not persisted');
assert(memoryKeyStore.has('encryption-private'), 'encryption key not persisted');
```

Add tests proving session renewal signs the exact canonical challenge and `relayEvent` never includes `threadId`, bearer, Telegram token, or chat ID.

- [ ] **Step 2: Run and verify missing-file failure**

Run: `node tests/telegram-bridge-client.mjs`

Expected: FAIL because `src/telegram-bridge-client.js` does not exist.

- [ ] **Step 3: Implement device key and API client**

Create an IIFE that exposes only the factory:

```js
(() => {
  const DB_NAME = 'pal-telegram-bridge';
  const KEY_STORE = 'keys';
  const STATE_KEY = 'palTelegramBridgeState';

  function createClient(options) {
    // Generate ECDSA/ECDH P-256 keypairs, persist CryptoKey objects in IndexedDB,
    // export only public JWKs, obtain challenge sessions, and relay bounded events.
  }

  globalThis.PalTelegramBridge = Object.freeze({createClient});
})();
```

Production key storage uses IndexedDB structured cloning of non-extractable private `CryptoKey` objects. Tests inject `memoryKeyStore`. Public keys are exported as JWK. Pairing state and opaque conversation mappings use extension-local storage.

Use this event boundary:

```js
{
  mapping_id,
  event_id: String(signal.dedupeKey).slice(0, 220),
  kind: signal.kind,
  label: String(signal.label || '').slice(0, 128),
  title: String(signal.title || '').slice(0, 128),
  body: String(signal.body || '').slice(0, 240),
  text: String(signal.text || '').slice(0, 4096),
  timestamp: new Date(Number(signal.ts || Date.now() / 1000) * 1000).toISOString()
}
```

Create `mapping_id` as `map_<crypto.randomUUID()>` and store it under the raw `threadId` locally. Never include the local map key in API request diagnostics.

- [ ] **Step 4: Load the helper on every browser target**

Create Chromium entry:

```js
importScripts('telegram-bridge-client.js', 'background.js');
```

Change Chromium/root manifests to `service_worker: "src/background-entry.js"` without module type. Change Firefox/Safari background scripts to:

```json
"scripts": ["src/telegram-bridge-client.js", "src/background.js"]
```

Add both new files to `tools/build.mjs` shared paths. Update manifest/build assertions accordingly.

- [ ] **Step 5: Integrate the client into background runtime**

Construct the client once:

```js
const hostedTelegramBridge = globalThis.PalTelegramBridge.createClient({
  endpoint: LICENSE_API_BASE,
  ext,
  channel: LICENSE_CHANNEL
});
```

Add runtime handlers for the four `pal-bridge-*` control messages. In `handleTelegramEvent`, attempt hosted relay when paired, then preserve the existing legacy bot send path. A hosted relay failure must not expose secrets or break legacy notification behavior.

- [ ] **Step 6: Update fixtures and validation**

Run `telegram-bridge-client.js` before `background.js` in `tests/background-fixtures.mjs`. Add a deterministic fake bridge client and assert pairing handlers and hosted event forwarding. Update `tests/validate-extension.mjs` to assert new background entry loading for all targets.

- [ ] **Step 7: Run all focused tests and commit**

Run:

```bash
node tests/telegram-bridge-client.mjs
node tests/background-fixtures.mjs
node tests/validate-extension.mjs
```

Expected: all pass.

```bash
git add src/telegram-bridge-client.js src/background-entry.js src/background.js manifest.json manifests tools/build.mjs tests/telegram-bridge-client.mjs tests/background-fixtures.mjs tests/validate-extension.mjs package.json
git commit -m "feat: add hosted Telegram bridge client"
```

---

### Task 6: Add Hosted Bridge Pairing UI

**Files:**
- Modify: `popup.html`
- Modify: `src/popup.js`
- Modify: `src/popup.css`
- Modify: `tests/validate-extension.mjs`

**Interfaces:**
- UI controls: `telegramBridgeConnect`, `telegramBridgeDisconnect`, `telegramBridgeStatus`, `telegramBridgeOpenBot`.
- Consumes the `pal-bridge-*` background message contract from Task 5.

- [ ] **Step 1: Add failing popup contract assertions**

Add IDs to the popup assertion list and require the new runtime messages:

```js
for (const id of [
  'telegramBridgeConnect',
  'telegramBridgeDisconnect',
  'telegramBridgeStatus',
  'telegramBridgeOpenBot'
]) {
  assert(popup.includes(`id="${id}"`), `popup must expose ${id}`);
}
assert(popupScript.includes('pal-bridge-pair-start'), 'popup must start hosted pairing');
assert(popupScript.includes('pal-bridge-pair-status'), 'popup must poll pairing state');
assert(popupScript.includes('pal-bridge-disconnect'), 'popup must disconnect hosted bridge');
```

- [ ] **Step 2: Run and verify failure**

Run: `node tests/validate-extension.mjs`

Expected: FAIL with `popup must expose telegramBridgeConnect`.

- [ ] **Step 3: Add hosted bridge UI without removing legacy settings**

Inside the Telegram panel, add a leading hosted-service block:

```html
<section class="telegram-bridge-card" aria-label="Pure in Telegram">
  <div>
    <strong>Pure in Telegram</strong>
    <small data-i18n="telegramBridgeHint">Диалоги Pure по темам Telegram</small>
  </div>
  <p id="telegramBridgeStatus" class="telegram-status">Не подключено</p>
  <div class="telegram-bridge-actions">
    <button id="telegramBridgeConnect" class="secondary" type="button">Подключить</button>
    <a id="telegramBridgeOpenBot" class="secondary" target="_blank" rel="noreferrer" hidden>Открыть Telegram</a>
    <button id="telegramBridgeDisconnect" class="secondary subtle" type="button" hidden>Отключить</button>
  </div>
</section>
```

Keep the existing personal bot token/chat ID fields under an `advanced/legacy` label during Phase 1 so current users are not broken.

- [ ] **Step 4: Implement pairing state machine**

In `popup.js`, implement states `disconnected`, `pairing`, `paired`, `revoked`, and `error`. On connect, request pairing, set the bot URL, open it with `tabs.create`, and poll status every 2 seconds until paired/expired. Stop polling when popup closes. On disconnect, require a second click within 3 seconds before sending the disconnect command.

Add RU/EN strings for every visible state; never display raw API errors, secrets, device IDs, or pairing poll secrets.

- [ ] **Step 5: Style and validate**

Add compact styles that fit the existing popup width without increasing horizontal overflow. Run:

```bash
node tests/validate-extension.mjs
npm run validate
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add popup.html src/popup.js src/popup.css tests/validate-extension.mjs
git commit -m "feat: add Pure in Telegram pairing UI"
```

---

### Task 7: Relay Existing Pure Events into Hosted Topics

**Files:**
- Modify: `src/content.js`
- Modify: `tests/engagement-fixtures.mjs`
- Modify: `tests/background-fixtures.mjs`
- Modify: `tests/validate-extension.mjs`

**Interfaces:**
- Content-to-background event adds `threadId`, `messageKind`, and numeric `ts`.
- Background passes the full sanitized signal only to `hostedTelegramBridge.relayEvent(signal)`; legacy Telegram text generation remains unchanged.

- [ ] **Step 1: Add failing signal-boundary tests**

Assert that a detected incoming message produces:

```js
{
  kind: 'message',
  dedupeKey: 'message:chat.thread-2:message-2',
  threadId: 'chat.thread-2',
  text: 'Привет',
  messageKind: 'text',
  ts: 1783857600
}
```

Also assert that content still contains no `telegramBotToken`, `telegramChatId`, Pure bearer field, or relay API credential.

- [ ] **Step 2: Run and verify missing-thread failure**

Run: `node tests/engagement-fixtures.mjs && node tests/background-fixtures.mjs`

Expected: FAIL because `notifyTelegram` currently drops `threadId`, `messageKind`, and `ts`.

- [ ] **Step 3: Extend the sanitized runtime event**

Change only the signal object in `notifyTelegram`:

```js
signal: {
  kind: signal.kind,
  dedupeKey: signal.dedupeKey,
  title: signal.title || 'PureAutoLike',
  body: signal.body || 'Новое событие в Pure',
  source: signal.source || '',
  text: signal.text || '',
  label: signal.label || '',
  threadId: signal.threadId || '',
  messageKind: signal.messageKind || '',
  ts: Number(signal.ts) || Date.now() / 1000
}
```

Do not add bearer, x-js-user-agent, photo metadata, profile description, or raw network payloads.

- [ ] **Step 4: Add hosted relay outcome handling**

Background returns a combined response:

```js
{
  ok: hosted.ok || legacy.ok,
  hosted: {configured, sent, duplicate, errorCode},
  legacy: {configured, sent},
  lastEvent
}
```

If neither bridge is configured, return `{ok:true, skipped:true}` so content does not treat an optional integration as an extension failure.

- [ ] **Step 5: Run regression suite and commit**

Run: `npm run validate && npm run audit:clean`

Expected: all extension, engagement, background, bridge, photo, runner, build, and cleanliness checks pass.

```bash
git add src/content.js src/background.js tests/engagement-fixtures.mjs tests/background-fixtures.mjs tests/validate-extension.mjs
git commit -m "feat: mirror Pure events to hosted Telegram topics"
```

---

### Task 8: Document Privacy, Deployment, and Phase-1 Validation

**Files:**
- Modify: `PRIVACY.md`
- Modify: `docs/beta-billing-backend.md`
- Modify: `backend/license-worker/wrangler.toml.example`
- Modify: `tests/audit-clean.mjs`
- Modify: `tests/validate-extension.mjs`

**Interfaces:**
- Documents the exact Worker secrets and Telegram webhook registration command.
- Establishes privacy assertions enforced by tests.

- [ ] **Step 1: Add failing privacy assertions**

Require the privacy policy to state:

```js
assert(privacy.includes('Telegram stores relayed messages'), 'Telegram retention disclosure missing');
assert(privacy.includes('not stored in the PureAutoLike database after delivery'), 'relay retention disclosure missing');
assert(privacy.includes('browser must be running'), 'browser availability limitation missing');
```

Extend `audit-clean` patterns to reject committed values matching `TELEGRAM_BOT_TOKEN=`, `TELEGRAM_WEBHOOK_SECRET=`, and raw `/bot<token>/` URLs outside fixtures.

- [ ] **Step 2: Run and verify documentation failure**

Run: `node tests/validate-extension.mjs && node tests/audit-clean.mjs`

Expected: FAIL on the missing disclosures.

- [ ] **Step 3: Update privacy policy**

Document that:

- the relay processes Pure message text transiently to send it to Telegram;
- Telegram stores relayed messages under the user's Telegram account and policies;
- successful Pure-to-Telegram bodies are not stored in the PureAutoLike database after delivery;
- Phase 1 only works while the browser/Pure adapter is running;
- raw Pure conversation IDs and bearer tokens are never sent to the relay;
- device public keys, opaque mappings, and dedupe hashes are stored for operation/security.

- [ ] **Step 4: Add deployment runbook**

Document exact commands:

```bash
cd backend/license-worker
npx wrangler d1 execute pureautolike_license --remote --file=schema.sql
npx wrangler secret put TELEGRAM_BOT_TOKEN
npx wrangler secret put TELEGRAM_WEBHOOK_SECRET
npx wrangler deploy
curl -X POST "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/setWebhook" \
  -H 'Content-Type: application/json' \
  -d '{"url":"https://pureautolike-license.ziganshinoff.workers.dev/v1/telegram/webhook","secret_token":"'"${TELEGRAM_WEBHOOK_SECRET}"'","allowed_updates":["message"]}'
```

Include webhook verification with `getWebhookInfo`, D1 inspection queries that select metadata only, rollback by deleting webhook/feature flag, and a warning never to paste secrets into committed TOML.

- [ ] **Step 5: Run full validation**

Run:

```bash
npm run validate
npm run audit:clean
npm --prefix backend/license-worker run check
git diff --check
```

Expected: all commands pass with no secret, syntax, build, or whitespace errors.

- [ ] **Step 6: Manual smoke checklist**

Using a development bot and test Telegram account:

1. Start pairing from unpacked Chromium build.
2. Complete `/start` and verify popup changes to paired.
3. Trigger two Pure messages in one conversation and verify one topic is reused.
4. Trigger a second Pure conversation and verify a second topic is created.
5. Replay an event ID and verify no duplicate Telegram message.
6. Re-pair in a second browser and verify the first device becomes revoked.
7. Disable the Worker and verify local autoliker remains usable.
8. Inspect D1/logs and verify no message body, Pure token, or raw Pure conversation ID exists.

- [ ] **Step 7: Commit**

```bash
git add PRIVACY.md docs/beta-billing-backend.md backend/license-worker/wrangler.toml.example tests/audit-clean.mjs tests/validate-extension.mjs
git commit -m "docs: document Telegram bridge privacy and rollout"
```

---

## Phase 1 Completion Gate

Phase 1 is complete only when:

- all automated commands in Task 8 pass;
- manual smoke steps 1–8 have recorded outcomes;
- one private Telegram bot chat contains distinct, reused topics for at least two Pure conversations;
- D1 and logs contain no relayed message body, raw Pure bearer token, or raw Pure conversation ID;
- legacy personal-bot notifications and all local extension features still work;
- the hosted relay can be disabled without disabling the local autoliker.

After this gate, create the separate Phase 2 plan for Telegram-to-Pure replies. Phase 2 begins by capturing and fixture-validating a real user-initiated Pure send request, then adds the ECDH-encrypted 24-hour delivery queue and ordered acknowledgement flow defined in the approved design.
