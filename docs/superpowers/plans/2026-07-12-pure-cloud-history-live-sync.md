# Pure Cloud Full History And Live Sync Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox syntax for tracking.

**Goal:** Import every Pure conversation/message still accessible to the account into Telegram topics and maintain gap-free 24/7 inbound synchronization.

**Architecture:** Sanitized real fixtures define a versioned inbound adapter. Gateway connectors stream bounded chronological batches through signed Worker endpoints. D1 stores only opaque mappings, cursors, watermarks, hashes, counts, and status.

**Tech Stack:** Gateway foundation stack, Node WebSocket client, streaming Fetch, Telegram Bot API topics/media, D1 checkpoints.

## Global Constraints

- Do not start without safe fixtures for conversation list, history, WebSocket, refresh, photo download, and voice download.
- Import everything Pure still exposes; do not claim inaccessible/deleted history.
- Never load an account history into memory or mark imports read.
- Owner-only shared-IP test mode remains enforced.

---

### Task 1: Capture inbound fixture pack

**Files:** create tests/fixtures/pure-protocol/v1/{conversations,history-first,history-next,websocket,session-refresh,photo-download,voice-download}.json; modify safety tests.

- [ ] Run:

    npm run listen:pure -- --target pure.app --duration 180000 --reload

  During capture, open/paginate chats, open old history, receive owner-controlled text/photo/voice, and allow a normal refresh. Raw data stays under analysis/.
- [ ] Sanitize fixtures and run node tests/pure-protocol-fixtures.mjs. It must reject raw credentials, IDs, URLs with secrets, names, and bodies while preserving method/path/pagination/key/type/codec shapes.
- [ ] Manually verify each captured operation and commit only safe fixtures.

### Task 2: Fixture-locked inbound adapter

**Files:** create backend/pure-gateway/src/pure/adapter-v1.js, http-client.js, message-normalizer.js, and test/adapter-v1.mjs.

**Produces:** listConversations(session,cursor), listHistory(session,rawConversationId,cursor), refreshSession(session), normalizePureMessage(raw).

- [ ] Write RED fixture tests for exact methods/paths/header names/pagination, terminal cursors, chronology, source IDs, direction, text/photo/voice, refresh-once, byte/time bounds, and PURE_PROTOCOL_UNSUPPORTED on drift.
- [ ] Run RED; implement only captured operations.
- [ ] Enforce approved Pure API/WebSocket/CDN hosts and reject redirects elsewhere.
- [ ] Run GREEN and commit.

### Task 3: Internal topic and import delivery API

**Files:** modify gateway-control.js, telegram-bridge.js, and cloud-gateway-worker tests.

**Produces:** POST /internal/gateway/topics/ensure, /internal/gateway/import/batch, /internal/gateway/events.

- [ ] Write RED tests for opaque mapping only, topic idempotency, chronological maximum-50 batches, live dedupe, no D1 bodies/media URLs, checkpoint only after Telegram ack, partial failure last-acked index, and Telegram retry_after.
- [ ] Run RED.
- [ ] Implement sendMessage/sendPhoto/sendVoice/sendAudio with bounded streams. Worker never persists media.
- [ ] Run GREEN and commit.

### Task 4: Resumable complete import

**Files:** create backend/pure-gateway/src/import/import-runner.js and import-scheduler.js; modify connector-manager.js; create test/full-import.mjs.

**Produces:** ImportRunner.run(accountLease,signal), with checkpoints for chat cursor, history cursor, oldest flag, and counts.

- [ ] Write RED tests: multiple chat/history pages, reverse provider order to chronological Telegram order, restart mid-page, overlap dedupe, empty chats, media placeholders, cancellation, 429 pause, bounded memory/concurrency, and completion only after every chat reaches oldest.
- [ ] Run RED.
- [ ] Implement account concurrency 1 and global concurrency 2 in test mode; batches max 50 text or one media; checkpoint contains no body.
- [ ] Run GREEN and commit.

### Task 5: Live WebSocket plus REST reconciliation

**Files:** create pure/live-connection.js and pure/reconciler.js; modify connector-manager.js; create test/live-sync.mjs.

- [ ] Write RED tests for captured auth/subscribe frames, text/photo/voice, ping/pong, close/reconnect, capped jitter, credential refresh, missed REST events, WS/REST overlap, outgoing echo suppression, and compatibility_required on unknown frames.
- [ ] Run RED.
- [ ] Implement state machine importing → live → reconnecting/rate_limited/reauth_required/compatibility_required. Commit provider watermarks only after Telegram ack. Reconcile REST before resuming live.
- [ ] Run GREEN and commit.

### Task 6: Status surfaces and controlled live verification

**Files:** modify Worker bridge, extension client/popup, relevant tests, and cloud runbook.

- [ ] Write RED status tests for discovered/completed chats, imported messages, state, last sync, rate delay, reauth, test badge, and /status output without raw IDs/text.
- [ ] Implement adaptive popup polling: 2 seconds activation/import, 15 live, 30 error.
- [ ] Deploy owner-only. Import all accessible chats, compare counts, interrupt import/Gateway, verify resume/dedupe, close browser, and verify inbound text/photo/voice.
- [ ] Run npm validation/audit/build, Worker check, Gateway test/check, diff check.
- [ ] Commit status/docs. Do not begin outbound sends until the outbound fixture pack exists.

