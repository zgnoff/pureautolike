# Pure Cloud Gateway Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox syntax for tracking.

**Goal:** Build encrypted Pure-session handoff, Worker control APIs, and a long-running Gateway skeleton without enabling cloud history or sends.

**Architecture:** The page bridge encrypts an allowlisted session directly to a pinned Gateway ECDH public key. The Worker stores ciphertext and offers HMAC-signed internal leases. A dependency-free Node 24 Gateway decrypts only in memory and remains compatibility-blocked until real Pure fixtures exist.

**Tech Stack:** ES2022, Web Crypto P-256 ECDH/HKDF/AES-GCM, WebExtensions, Cloudflare Workers/D1, Node 24, systemd.

## Global Constraints

- Plain Pure credentials never cross content/background messages or enter D1/logs/tests.
- The page bridge exports ciphertext only; it never exports the cookie jar wholesale.
- Shared-IP mode is owner-only test mode.
- No undocumented Pure operation is invented.
- Every behavior follows a witnessed RED → GREEN cycle.

---

### Task 1: Credential-safe protocol fixtures

**Files:** create tools/pure-protocol-sanitize.mjs and tests/pure-protocol-fixtures.mjs; modify tools/pure-api-listener.mjs and package.json.

**Produces:** sanitizeProtocolEvent(event) and assertFixtureSafe(value).

- [ ] Write a failing test using seeded Authorization, Cookie, query tokens, raw IDs, names, and message text. Require normalized method/path, sorted header names, recursive key/type shape, and absence of every seed.
- [ ] Run node tests/pure-protocol-fixtures.mjs; verify module-not-found RED.
- [ ] Implement bounded structural sanitization: allowlisted hosts, path placeholders, no header values, recursive type shapes, depth/key limits, and a denylist safety scan.
- [ ] Make the listener keep raw captures only in gitignored analysis/ and emit a fixture only after assertFixtureSafe passes.
- [ ] Add the suite to npm run validate and verify all tests.
- [ ] Commit:

    git add tools/pure-protocol-sanitize.mjs tools/pure-api-listener.mjs tests/pure-protocol-fixtures.mjs package.json
    git commit -m "test: sanitize Pure protocol captures"

### Task 2: Cloud schema contract

**Files:** modify backend/license-worker/schema.sql and tests/validate-extension.mjs; create tests/cloud-gateway-worker.mjs.

**Produces:** bridge_cloud_sessions, bridge_cloud_consents, bridge_gateway_nonces, bridge_gateway_leases, bridge_sync_state, bridge_delivery_queue, bridge_media_transfers.

- [ ] Write RED assertions for every table and required session/queue/cursor/index column. Reject schema columns named bearer, refresh_token, cookie_value, message_body, or plaintext.
- [ ] Run node tests/cloud-gateway-worker.mjs; verify missing bridge_cloud_sessions.
- [ ] Add account/device foreign keys, unique consent versions, nonce hashes, 60-second leases, sync states, 24-hour queue expiry, visibility timeout, ordering/idempotency keys, and media metadata only.
- [ ] Run focused schema tests GREEN.
- [ ] Commit schema and tests only.

### Task 3: Page-world session encryption

**Files:** create src/cloud-session-envelope.js and tests/cloud-session-envelope.mjs; modify src/page-bridge.js, manifests, and tools/build.mjs.

**Produces:** PalCloudEnvelope.encryptSession(options), plus page message cloud-session-export → cloud-session-result.

- [ ] Write a real Web Crypto test: generate Gateway ECDH P-256 keys, encrypt a seeded bearer/x-js-user-agent session, decrypt with the Gateway private key, verify exact JSON, and prove the serialized envelope contains no plaintext seed.
- [ ] Run RED; expect missing module.
- [ ] Implement ephemeral ECDH P-256, HKDF-SHA-256 with random 32-byte salt, AES-256-GCM with random 12-byte IV, and AAD binding version/key/account/createdAt.
- [ ] Load the module before page-bridge. Validate channel, P-256 public JWK, account binding, and 30-second request freshness. Build the allowlist from page state and post ciphertext only.
- [ ] Build Chromium/Firefox/Safari and run all tests GREEN.
- [ ] Commit envelope, page bridge, manifests, tests, and build changes.

### Task 4: Worker cloud activation endpoints

**Files:** modify backend/license-worker/src/telegram-bridge.js, tests/cloud-gateway-worker.mjs, and wrangler.toml.example.

**Produces:** GET /v1/cloud/config, POST /v1/cloud/consent, PUT/DELETE /v1/cloud/session, GET /v1/cloud/status.

- [ ] Write RED endpoint tests for authenticated active device, consent requirement, warning version, 64 KiB envelope cap, key/account binding, rotation, redacted status, inactive account, test allowlist, and destructive idempotent cleanup.
- [ ] Run RED; expect /v1/cloud/config 404.
- [ ] Implement stable errors CONSENT_REQUIRED, INVALID_ENVELOPE, GATEWAY_KEY_MISMATCH, ACCOUNT_INACTIVE, CLOUD_TEST_DISABLED. Never return stored ciphertext to extension routes.
- [ ] Document GATEWAY_PUBLIC_JWK, GATEWAY_KEY_ID, CLOUD_TEST_ENABLED, CLOUD_TEST_ACCOUNT_IDS, CLOUD_WARNING_VERSION.
- [ ] Run Worker tests/check GREEN and commit.

### Task 5: Popup/background activation

**Files:** modify src/telegram-bridge-client.js, background.js, content.js, popup files, and their fixture tests.

**Produces:** cloudConfig, acceptCloudRisk, activateCloud, cloudStatus, deactivateCloud; runtime messages pal-cloud-activate/status/deactivate.

- [ ] Write RED tests requiring pairing, unchecked-by-default versioned consent, encrypted envelope request from active Pure page, no plaintext through runtime messages, test-mode badge, status, reauth, and destructive disconnect.
- [ ] Run focused RED suites.
- [ ] Implement Russian/English warning, config fetch, page ciphertext request, authenticated upload, adaptive status polling, and removal of any transient envelope after upload.
- [ ] Run client/background/popup tests GREEN and commit.

### Task 6: Gateway service foundation

**Files:** create backend/pure-gateway/package.json; src/config.js, crypto.js, control-client.js, connector-manager.js, main.js; test/foundation.mjs; deploy/pureautolike-gateway.service.

**Produces:** decryptSessionEnvelope, createControlClient, ConnectorManager.reconcile.

- [ ] Write RED tests for cross-runtime envelope decryption, AAD tampering, wrong key/account, HMAC canonical signing, nonce uniqueness, lease polling, redacted heartbeat, and credential-safe errors.
- [ ] Run npm --prefix backend/pure-gateway test; verify missing modules.
- [ ] Implement with Node built-ins only. Require CONTROL_PLANE_URL, GATEWAY_ID, GATEWAY_HMAC_SECRET, GATEWAY_PRIVATE_JWK, GATEWAY_KEY_ID. Bound response sizes/timeouts and wipe decrypted byte buffers after parsing.
- [ ] Implement connector states disabled/decrypting/authenticating/compatibility_required/revoked. Do not call Pure yet.
- [ ] Add hardened unprivileged systemd service with NoNewPrivileges, PrivateTmp, ProtectSystem, ProtectHome, memory limit, restart backoff, and one writable encrypted spool directory.
- [ ] Run Gateway test/check GREEN and commit.

### Task 7: HMAC internal lease/heartbeat boundary

**Files:** create backend/license-worker/src/gateway-control.js; modify Worker router/package and Worker/Gateway tests.

**Produces:** POST /internal/gateway/leases and /internal/gateway/heartbeat. Canonical signature is method, path, timestamp, nonce, and SHA-256 body separated by newlines.

- [ ] Write RED tests for valid signature, ±30 seconds, replay, tamper, wrong gateway, lease exclusivity/expiry, inactive omission, ciphertext only on internal routes, and enumerated heartbeat states.
- [ ] Run RED suites.
- [ ] Implement constant-time HMAC verification, five-minute nonce hashes, maximum 20 leases and 1 MiB response, and privacy-safe heartbeat fields.
- [ ] Run Worker/Gateway tests GREEN and commit.

### Task 8: Controlled deployment and stop gate

**Files:** modify PRIVACY.md and docs/beta-billing-backend.md; create docs/cloud-gateway-runbook.md; update validation assertions.

- [ ] Write RED documentation tests for encrypted credential processing, no password, shared-IP risk, key rotation, destructive deletion, and test-only mode.
- [ ] Write exact key generation, Wrangler secret, D1 migration, systemd, health, kill-switch, rollback, rotation, and deletion commands using placeholders only.
- [ ] Run root validation/audit/build, Worker check, Gateway test/check, and git diff --check.
- [ ] Commit docs/tests.
- [ ] Stop. Do not enable import or sends until sanitized real fixtures prove list/history/WebSocket/refresh operations.

