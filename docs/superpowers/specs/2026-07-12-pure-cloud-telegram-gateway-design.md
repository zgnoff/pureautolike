# Pure Cloud Telegram Gateway — Product and Architecture Design

**Date:** 2026-07-12

**Status:** Approved for implementation planning

**Supersedes:** The local-only availability constraint in `2026-07-12-pure-telegram-bridge-design.md`

## 1. Product decision

PureAutoLike will evolve from an inbound browser relay into a cloud-backed Telegram client for a user's Pure conversations. A user pairs the shared `@purenotificationbot` once, transfers an encrypted Pure session from the extension, and then reads and writes Pure conversations through private Telegram bot topics even while the browser is offline.

Each Pure conversation maps to one private Telegram topic. Initial pairing automatically imports every conversation and every message that the authenticated Pure account can still retrieve. After import, a long-running gateway maintains the Pure connection and mirrors new activity continuously.

The cloud mode is materially riskier than the existing local extension. Pure's current terms prohibit automated access without prior written consent and allow account restrictions. Before session transfer, the UI must show an explicit warning that cloud synchronization may violate Pure's rules and may result in account limitation or termination. Acceptance is recorded with the warning version and timestamp. A warning is disclosure, not a claim of permission or safety.

The first controlled test uses the VPS public IP. Public production rollout is blocked until per-account proxy support is implemented and enforced.

## 2. User experience

### 2.1 Cloud activation

1. The user pairs the extension with the Telegram bot using the existing single-use flow.
2. The popup explains the automation and account-blocking risk and requires explicit acceptance.
3. The extension captures only the Pure session material proven necessary for authenticated API access and session renewal. It never asks for or stores the Pure password.
4. The extension encrypts the session envelope to the gateway's pinned public key and uploads the ciphertext through the authenticated bridge API.
5. The gateway validates the envelope, stores it encrypted at rest, starts the account connector, and reports activation state to the popup and `/status` command.

The session envelope is allowlisted and versioned. It may contain a bearer token, refresh token or equivalent renewal material, required cookies, and device metadata only after each field has been observed in a real Pure authentication/refresh flow. The extension must not export the browser cookie jar wholesale.

### 2.2 Automatic full import

Cloud activation automatically starts a complete import without another button:

1. The connector retrieves every conversation visible to the Pure account, including inactive conversations when the API exposes them.
2. It creates or reuses an opaque local mapping and one Telegram topic per conversation.
3. It paginates each Pure history endpoint until the oldest accessible message is reached.
4. It sends messages to Telegram in chronological order.
5. Text, photos, and voice messages are transferred in their native Telegram-compatible form when Pure exposes downloadable media; unsupported kinds receive a compact labeled placeholder rather than being silently dropped.
6. It checkpoints the conversation cursor after every successfully acknowledged page or bounded batch.
7. On restart, rate limit, or transient failure, import resumes from the checkpoint without duplicating Telegram messages.

The popup and `/status` expose counts for discovered conversations, completed conversations, imported messages, current rate-limit delay, and the latest privacy-safe error. Import does not mark Pure messages read.

### 2.3 Continuous Pure-to-Telegram synchronization

After a conversation is caught up, the connector subscribes to the real Pure chat WebSocket protocol and uses REST reconciliation after reconnects. Incoming text, photos, and voice messages are forwarded into the mapped Telegram topic. Successfully forwarded bodies are not retained by PureAutoLike storage.

The connector maintains an event watermark and deduplication hash so that WebSocket delivery and REST reconciliation may overlap safely. A reconnect never assumes that no events were missed.

### 2.4 Telegram-to-Pure communication

The user may send text, a photo, or a voice message inside a mapped Telegram topic. The webhook rejects topic-less messages, bot-authored messages, messages from another Telegram identity, unsupported attachments, oversized payloads, and topics without an active Pure mapping.

Accepted commands are encrypted immediately and queued for at most 24 hours. The gateway claims commands in per-conversation order and sends them using request shapes captured from real, user-initiated Pure sends. It does not invent undocumented endpoints or payloads.

Successful delivery is silent. The bot sends one compact error message only when delivery permanently fails or the 24-hour TTL expires. After a successful Telegram-originated reply, the gateway invokes the observed Pure read-status operation for that conversation. Merely importing or viewing a Telegram topic never marks the Pure conversation read because Telegram Bot API does not provide a reliable topic-read event.

### 2.5 Disconnect and deletion

Disconnect revokes device and gateway access, closes the Pure connector, deletes pending commands, deletes the encrypted Pure session, and removes server mappings and cursors. Telegram's already delivered messages remain subject to Telegram's storage and deletion behavior. The user may reconnect later as a fresh cloud activation.

## 3. Architecture

### 3.1 Browser extension

The extension remains the bootstrap and recovery surface. It owns:

- risk disclosure and consent;
- allowlisted Pure session capture;
- gateway public-key pinning and session-envelope encryption;
- session rotation uploads when the live Pure web app renews credentials;
- cloud status, reauthentication, and disconnect controls;
- capture of real Pure history, send, media, read-status, and refresh protocol fixtures during controlled development.

The extension stops being the normal message transport after cloud activation. It remains capable of updating an expired cloud session without asking for the Pure password.

### 3.2 Cloudflare Worker control plane

The existing Worker remains the public API and control plane:

- Telegram webhook and Bot API calls;
- pairing, account, device, entitlement, and consent state;
- opaque conversation-to-topic mappings;
- import status and privacy-safe diagnostics;
- encrypted command queue and idempotency;
- authenticated internal API for the gateway;
- session-envelope intake without plaintext logging.

D1 stores routing metadata, cursors, ciphertext, hashes, timestamps, and statuses. It does not store plaintext conversation bodies or plaintext Pure session credentials.

### 3.3 Pure Gateway data plane

A separate long-running service runs on a VPS because persistent per-account Pure WebSocket connections do not fit the short request lifecycle of the existing Worker. The gateway owns:

- encrypted session vault access;
- one account connector state machine per active account;
- Pure REST pagination and WebSocket subscriptions;
- session refresh and credential rotation;
- import scheduling and Telegram rate-limit backpressure;
- text/photo/voice downloads and uploads;
- ordered command execution, reconciliation, and read-status updates;
- reconnect and health heartbeats.

The initial gateway is a single Node.js process supervised by systemd. One CPU and 1 GB RAM are sufficient for the controlled single-account test. Capacity is measured before setting a public account limit.

### 3.4 Internal gateway protocol

Worker-to-gateway calls use HMAC-SHA-256 signed requests with a dedicated deployment secret separate from extension sessions. Every mutation includes a timestamp, nonce, body digest, account ID, and idempotency key. Requests outside the timestamp window or with reused nonces fail closed. Mutual TLS may be added later as defense in depth but is not required by the first controlled test.

The gateway never exposes a public endpoint that accepts arbitrary Pure URLs or request bodies. Pure operations are selected from versioned, allowlisted adapter methods.

## 4. Pure protocol discovery gate

Cloud sending cannot be enabled until controlled captures establish the exact protocol for:

- listing all conversations and pagination;
- paginating complete history;
- WebSocket authentication, subscription, incoming events, and reconnect;
- bearer/session renewal;
- sending text;
- uploading and sending photos;
- uploading and sending voice messages;
- marking a conversation read;
- media download authorization and expiry.

Each capture is sanitized into a fixture with credentials, user IDs, conversation IDs, URLs containing secrets, and message content replaced by deterministic test values. Adapter implementation is driven by these fixtures. An unknown Pure schema version places the affected account into `compatibility_required` rather than guessing a request.

## 5. Data model

### 5.1 `bridge_cloud_sessions`

- account ID and active device ID;
- session-envelope version and ciphertext;
- gateway key ID;
- credential fingerprint hash;
- status: `pending`, `active`, `reauth_required`, `revoked`;
- accepted risk-warning version and timestamp;
- created, rotated, last-used, and revoked timestamps.

### 5.2 `bridge_sync_state`

- account ID and opaque mapping ID;
- import state and chronological cursor;
- oldest-reached flag;
- last REST watermark and WebSocket watermark;
- imported message count;
- last success and privacy-safe error code.

No raw Pure conversation ID is stored in the Worker database. The encrypted session vault or gateway-local encrypted mapping store may contain the raw identifier because the cloud connector must call Pure, but it is encrypted at rest and never appears in logs or external APIs.

### 5.3 `bridge_delivery_queue`

- command ID, account ID, device/gateway target, and opaque mapping ID;
- Telegram chat, thread, and source message IDs for error reporting;
- command kind and encrypted payload;
- creation, visibility, claim, and 24-hour expiry timestamps;
- state and bounded attempt count;
- idempotency and ordering keys.

Plaintext command bodies and Telegram file contents are never persisted in D1. Delivered records are deleted immediately. Failed/expired ciphertext is deleted after the single Telegram error notification is acknowledged.

### 5.4 `bridge_media_transfers`

Media normally streams without durable storage. If a provider requires a temporary file, the gateway uses a private bounded spool encrypted on disk, records only metadata and a random transfer ID, and deletes the file after acknowledgement or within one hour. Telegram-to-Pure commands still expire after 24 hours, but media must be re-fetched from Telegram when no local spool exists.

### 5.5 Dedupe and operational state

Event and command hashes are retained for no more than seven days. Operational logs are retained for no more than 30 days and exclude message bodies, media, Pure credentials, Telegram bot credentials, raw Pure conversation IDs, and decrypted session material.

## 6. Connector state machine

Each account moves through:

`disabled → decrypting → authenticating → importing → live → reconnecting`

Exceptional states are:

- `rate_limited` — wait for the provider-specified or exponential delay;
- `reauth_required` — credentials cannot be refreshed; prompt extension recovery;
- `compatibility_required` — observed Pure protocol no longer matches fixtures;
- `risk_blocked` — consent missing or public rollout lacks required proxy support;
- `revoked` — stop immediately and delete credentials/queue.

Reconnect uses capped exponential backoff with jitter. After reconnect, REST reconciliation begins from the last committed watermark before WebSocket live delivery resumes. Per-account and per-conversation locks prevent concurrent imports or out-of-order sends.

## 7. Rate limits and resource controls

- Telegram `429` responses honor `retry_after` exactly.
- Pure `429` and transient `5xx` responses use capped exponential backoff.
- Full import uses bounded batches and never loads an entire account history into memory.
- Media has explicit byte limits before download and upload.
- Queue and import concurrency are bounded globally and per account.
- A circuit breaker stops an account after repeated authentication or compatibility failures.
- The controlled test uses the shared VPS IP. Production feature flags remain disabled until per-account proxy configuration, validation, isolation, and health checks exist.

## 8. Security and privacy

The gateway necessarily decrypts Pure credentials and message bodies in memory to act as a cloud client. The product must not describe this as end-to-end encryption.

- The extension pins the gateway session-encryption public key.
- Private session-decryption keys and at-rest master keys are injected as deployment secrets and are absent from source control and D1.
- Session ciphertext uses an authenticated envelope with key ID, version, account/device binding, creation time, and replay protection.
- Gateway memory and errors never serialize decrypted credentials.
- Internal APIs enforce account binding and entitlement on every operation.
- Telegram webhook identity, chat ID, and topic mapping are verified before queueing a command.
- Disconnect and account deletion are destructive and idempotent.
- Backups containing ciphertext follow the same deletion schedule and key-rotation policy.
- The privacy policy discloses cloud credential processing, transient message/media processing, Telegram retention, Pure automation risk, and the exact 24-hour command TTL.

## 9. Media behavior

### 9.1 Pure to Telegram

- Text becomes `sendMessage`.
- Pure photos become `sendPhoto` using a bounded stream.
- Pure voice/audio becomes `sendVoice` when Telegram accepts the codec, otherwise `sendAudio` or a labeled document fallback.
- Unsupported or expired media becomes a single placeholder carrying type and timestamp, never a fabricated success.

### 9.2 Telegram to Pure

- Text is normalized and bounded before queue encryption.
- Photos use the highest appropriate Telegram file variant, are streamed to the observed Pure upload flow, and then referenced by the observed send operation.
- Voice messages are downloaded from Telegram, validated, and transcoded only if the captured Pure protocol requires a supported codec. Transcoding runs with strict CPU, time, and size limits.
- Captions are preserved only when the Pure message schema supports them; otherwise the media and caption are sent as two ordered commands.

## 10. Delivery semantics

- Import and incoming events are at-least-once with deduplication.
- Telegram-originated commands are ordered per conversation.
- Queue claim uses a visibility timeout; abandoned claims return to pending.
- Pure success is confirmed by the provider response or matching server echo, not merely by a completed network write.
- Success is silent in Telegram.
- Permanent failure and 24-hour expiry produce exactly one compact error in the source topic.
- A successful Telegram reply triggers the observed Pure read-status operation.
- Reconciliation must not echo the user's Telegram-originated message back as a new incoming notification.

## 11. Commands and UI

The bot supports:

- `/status` — cloud connector state, import progress, last successful sync, queue count, and reauthentication need;
- `/disconnect` — destructive disconnect and queue/session deletion;
- `/privacy` — cloud processing, retention, and risk summary.

The popup supports:

- risk warning and acceptance;
- activate cloud sync;
- import/live/reconnect status;
- reauthenticate session;
- destructive disconnect;
- a test-mode badge while shared-IP operation is enabled.

## 12. Testing and rollout gates

### 12.1 Automated tests

- sanitized Pure protocol fixtures for every allowlisted adapter operation;
- complete pagination to the oldest message;
- chronological import, checkpoint resume, and deduplication;
- text/photo/voice mapping in both directions;
- session envelope encryption, tamper rejection, rotation, and deletion;
- Telegram identity/topic authorization;
- 24-hour encrypted queue, visibility timeout, ordering, ack, expiry, and single error notification;
- reconnect plus REST reconciliation without gaps or duplicates;
- rate-limit backpressure and circuit breaker;
- log/storage scans proving plaintext credentials and messages are absent;
- disconnect cleanup;
- compatibility failure on unknown fixture/schema versions.

### 12.2 Controlled live test

1. Use one owner-controlled Pure account and the deployed test bot.
2. Capture and sanitize real session-refresh and messaging protocols.
3. Import the complete accessible history and compare conversation/message counts.
4. Verify live inbound text/photo/voice.
5. Verify Telegram outbound text/photo/voice and Pure read status.
6. Stop the browser and prove the gateway remains live.
7. Restart the gateway during import and during a queued reply to prove recovery.
8. Disconnect and verify session, queue, mapping, spool, and connector deletion.

### 12.3 Public rollout blockers

Public rollout remains disabled until all of the following are true:

- per-account proxy support is enforced and tested;
- Pure protocol fixtures cover every enabled operation;
- entitlement checks protect activation, session rotation, import, live sync, and outbound commands;
- privacy policy and UI disclosures match actual processing;
- backup deletion and key rotation are operationally verified;
- capacity limits and incident kill switches are configured;
- the operator has evaluated Pure's terms and the need for written permission.

## 13. Explicit non-goals for the first cloud release

- multiple simultaneous Pure devices per Telegram account;
- arbitrary file, video, sticker, location, and contact sending;
- editing or deleting already sent Pure messages;
- reliable Telegram topic-read synchronization;
- storing a searchable duplicate of Pure history outside Telegram;
- public production traffic through the shared test VPS IP;
- bypassing Pure authentication, moderation, rate limits, or technical restrictions.
