# Pure Cloud Telegram Replies And Media Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox syntax for tracking.

**Goal:** Deliver ordered Telegram text/photo/voice replies to Pure within 24 hours, mark Pure read after success, report only terminal failures, and delete every payload/temp file.

**Architecture:** The Telegram webhook authorizes identity/topic and encrypts a bounded command for Gateway. Signed claim/ack gives per-chat ordering and visibility timeouts. Gateway uses fixture-locked send/upload/read operations, confirms provider ack/echo, silently deletes success, and emits exactly one terminal error.

**Tech Stack:** Earlier cloud stacks, Telegram getFile, streaming multipart, bounded ffmpeg only if captured voice requirements demand conversion.

## Global Constraints

- Do not enable an operation without safe text/photo/voice/read/ack fixtures.
- Queue TTL is exactly 24 hours; success ciphertext is deleted immediately.
- Success is silent; permanent failure/expiry emits exactly one error.
- Only a successful Telegram reply marks Pure read.
- Only the paired Telegram identity and mapped private topic may enqueue.

---

### Task 1: Capture outbound fixture pack

**Files:** create tests/fixtures/pure-protocol/v1/{send-text,upload-photo,send-photo,upload-voice,send-voice,mark-read,send-ack}.json; modify safety tests.

- [ ] Run the listener and manually send deterministic owner-controlled text/photo/voice from Pure Web, then mark a peer message read. Capture request/response and echo.
- [ ] Sanitize and prove absence of credentials, IDs, filenames, bytes, and content while preserving structural, MIME, codec, and ack fields.
- [ ] Review and commit safe fixtures only.

### Task 2: Encrypted 24-hour command queue

**Files:** create backend/license-worker/src/cloud-command-queue.js; modify telegram-bridge.js and Worker tests.

**Produces:** enqueueTelegramCommand; GET /internal/gateway/commands/claim; POST /internal/gateway/commands/:id/ack.

- [ ] Write RED tests for user/chat/topic authorization, text/photo/voice normalization, unsupported/oversized/bot messages, Telegram update dedupe, AES-GCM ciphertext-only D1, exact TTL, per-topic order, 60-second visibility, abandoned retry, attempt cap, and revoked accounts.
- [ ] Run RED.
- [ ] Encrypt with account/mapping/command AAD. Store Telegram file ID, not bytes. Claim only the first available command for each ordering key.
- [ ] Run GREEN and commit.

### Task 3: Fixture-locked outbound Pure adapter

**Files:** create backend/pure-gateway/src/pure/outbound-adapter-v1.js and test/outbound-adapter-v1.mjs.

**Produces:** sendText, sendPhoto, sendVoice, markRead.

- [ ] Write RED tests for exact captured method/path/header/payload shapes, bounds, MIME/codec, upload-before-send references, response/echo ack, idempotency, one refresh retry, permanent 4xx, temporary 429/5xx, and unknown schema.
- [ ] Run RED.
- [ ] Build every request internally from validated command fields. Queue data cannot supply arbitrary URLs, headers, or request bodies.
- [ ] Run GREEN and commit.

### Task 4: Telegram media and bounded spool/transcoding

**Files:** create backend/pure-gateway/src/media/{telegram-media,transcode,spool}.js and test/media.mjs; modify systemd service.

- [ ] Write RED tests for getFile authorization, Telegram host allowlist, streamed byte caps, MIME mismatch, timeout, encrypted 0600 spool, deletion on all paths/one-hour janitor, and subprocess CPU/time/output limits.
- [ ] Run RED.
- [ ] Prefer streaming. Invoke ffmpeg only when fixture requirements demand it, with fixed argv and no shell/user interpolation.
- [ ] Run GREEN and commit.

### Task 5: Ordered command runner and echo suppression

**Files:** create commands/command-runner.js; modify connector-manager.js and reconciler.js; create test/command-runner.mjs.

- [ ] Write RED tests for mixed ordered commands, one active per chat, parallel different chats, expiry, temporary/permanent failures, provider ack, lost ack plus echo reconciliation, restart after send-before-ack, outgoing echo suppression, mark-read, and cleanup.
- [ ] Run RED.
- [ ] Use command ID as provider idempotency seed when captured protocol permits. Otherwise reconcile captured echo fingerprint before retrying ambiguous sends.
- [ ] Run GREEN and commit.

### Task 6: Silent success, single error, and cleanup

**Files:** modify cloud-command-queue.js, telegram-bridge.js, and Worker tests.

- [ ] Write RED tests for immediate success deletion, retry retention, one permanent/expiry error, delete after Telegram error ack, Telegram 429 retry without duplicates, disconnect bulk deletion, and no success notification.
- [ ] Run RED.
- [ ] Implement scheduled plus opportunistic cleanup. Map stable error codes to safe text; never include raw provider errors.
- [ ] Run GREEN and commit.

### Task 7: End-to-end/privacy release gate

**Files:** modify PRIVACY.md and cloud runbook; create tests/cloud-e2e-fixtures.mjs; modify package validation.

- [ ] Write RED assertions for warning, cloud credential handling, transient media, encrypted 24-hour queue, silent success, read-on-reply, shared-IP test badge, and destructive deletion.
- [ ] Automate pairing → consent → upload → lease → import → inbound → Telegram text/photo/voice → Pure ack/read → cleanup; seed and scan D1/log/errors for plaintext.
- [ ] Live-test both directions, browser closed, Gateway restarts at queue boundaries, temporary/permanent errors, silent success/single error, Pure read state, disconnect deletion.
- [ ] Run all root/Worker/Gateway tests, audit, browser builds, and diff check.
- [ ] Commit tests/docs and keep feature owner-only until per-account proxy and all approved public rollout blockers are complete.

