# Pure in Telegram Bridge — Product and Architecture Design

**Date:** 2026-07-12

**Status:** Approved concept; implementation planning pending

**Product:** PureAutoLike browser extension + Telegram relay service

## 1. Product decision

PureAutoLike will not put the existing local autoliker behind an immediate hard paywall. The extension remains the acquisition and trust layer. The new premium-capable product is **Pure in Telegram**: a server-backed bridge that mirrors Pure conversations into a private Telegram bot chat and lets the user reply from Telegram.

The Telegram bot uses Telegram's private-chat threaded mode. Each Pure conversation maps to one Telegram topic. The bot chat is the user's `Pure` container; topics are individual matches or conversations.

This product boundary is intentional:

- local browser code can be unpacked and modified, so it is not a durable licensing boundary;
- the Telegram bot, relay API, device authorization, delivery queue, compatibility service, and future premium features remain server-controlled;
- copying or modifying the extension does not grant access to the hosted Telegram bridge.

The first release is a local relay. It works while the browser is running and the Pure page/extension adapter is available. A 24/7 cloud Pure client is explicitly outside the initial scope.

## 2. User experience

### 2.1 Pairing

1. The popup shows `Connect Telegram`.
2. The extension creates local signing and encryption key pairs if they do not exist.
3. The extension requests a single-use pairing code from the relay.
4. The popup opens `https://t.me/<bot>?start=<pairing-code>`.
5. The user presses Start in Telegram.
6. The webhook consumes the pairing code, binds the Telegram user/chat to the extension device, and sends a confirmation topic/message.
7. The popup observes the completed pairing and shows the Telegram bridge as connected.

Pairing codes expire after 10 minutes and are single-use. Re-pairing a Telegram account to a new device makes the new device active and revokes the previous device session automatically. No manual device-management screen is required for the MVP.

### 2.2 Incoming Pure conversations

1. The existing page bridge/content detector observes a new Pure match or incoming message.
2. The extension resolves the raw Pure conversation identifier to a locally stored opaque relay mapping ID, then builds a bounded event containing that mapping ID, event identifier, display label, event type, timestamp, and message text.
3. The extension signs the relay request with its device signing key.
4. The relay finds or creates the matching Telegram topic.
5. The relay sends the event to that topic and stores no message body after Telegram acknowledges delivery.

Topic titles use the safest available label, such as `Аня · 28`. Topic titles are sanitized and limited to Telegram's supported length. Sensitive profile descriptions are not placed in topic titles.

### 2.3 Replies from Telegram

1. The user writes in a Pure conversation topic.
2. Telegram sends the update to the relay webhook.
3. The relay resolves the topic to an opaque relay mapping ID and active device.
4. The reply body and opaque mapping ID are encrypted to the active device's public encryption key and added to a delivery queue.
5. While a Pure tab is active, the extension polls the queue using an adaptive interval, decrypts pending commands locally, and sends them through the Pure adapter.
6. The extension acknowledges success or a permanent failure. Successful commands are deleted immediately.
7. The bot posts a compact delivery status only when delivery fails or remains pending long enough to matter; successful delivery is silent by default.

Queued replies expire after 24 hours. Expired replies are deleted and the bot posts a failure notice in the corresponding topic.

### 2.4 Browser-off behavior

- Incoming Pure messages cannot be observed while the browser/Pure session is unavailable.
- Telegram replies remain encrypted in the queue for at most 24 hours.
- When the browser returns, the extension delivers queued replies in order per conversation.
- The bot clearly shows `waiting for browser` when a reply has not been delivered after a short grace period.

The product must not claim 24/7 Pure synchronization in this release.

## 3. System architecture

### 3.1 Extension components

#### Telegram bridge client

A new bounded extension module owns:

- device key generation and local key storage;
- pairing state;
- signed relay requests;
- adaptive queue polling;
- local decryption of queued replies;
- acknowledgements and health status.

Telegram bot credentials never enter the extension.

#### Pure event adapter

The existing `page-bridge.js` and `content.js` detection logic is exposed through a narrow adapter:

- `conversation.discovered`;
- `message.incoming`;
- `match.created`;
- stable event identifiers and locally maintained opaque conversation mappings;
- normalized, bounded message text.

The adapter must not send the Pure bearer token to the content script or relay.

#### Pure reply adapter

The reply adapter accepts only a locally decrypted command containing the mapped Pure conversation identifier and bounded text. It sends the reply from the active browser session. The exact Pure request shape must be derived from a recorded, user-initiated Pure send flow and locked down with fixtures before enabling Telegram-originated sends.

The adapter rejects:

- unknown conversations;
- commands for another device/account;
- expired commands;
- duplicate command IDs;
- empty or oversized text;
- sends when the Pure session is not authenticated.

### 3.2 Relay service

The initial deployment uses the existing Cloudflare Worker and D1 project. The relay is stateless except for D1 metadata and the encrypted delivery queue.

Responsibilities:

- Telegram webhook processing;
- pairing-code issuance and consumption;
- device/session verification;
- topic creation and mapping;
- Telegram Bot API calls;
- encrypted outbound queue;
- deduplication;
- rate limiting;
- entitlement/feature checks;
- privacy-safe operational metrics.

The relay must not:

- receive or store the Pure bearer token;
- maintain a server-side Pure session;
- store successfully delivered Pure message bodies;
- execute remote extension code;
- silently retain expired queue payloads.

### 3.3 Telegram bot

The bot runs with private-chat threaded mode enabled. It uses one private chat per Telegram user and one topic per Pure conversation.

Bot commands for MVP:

- `/start <pairing-code>` — pair the extension;
- `/status` — show connection, browser heartbeat, queue count, and beta/premium state;
- `/disconnect` — revoke the Telegram pairing and delete pending queue items;
- `/privacy` — explain transient processing and provide the privacy-policy link.

The webhook is protected with Telegram's `secret_token` header. The bot token is stored only as a Worker secret.

## 4. Identity and security model

### 4.1 Device identity

The extension generates two non-exported private keys with Web Crypto:

- ECDSA P-256 for request signatures;
- ECDH P-256 for deriving encryption keys for queued reply envelopes.

Only public keys are registered with the relay. If browser storage is cleared, the installation is a new device and must pair again.

### 4.2 Sessions

- The device signs a server-issued nonce to obtain a short-lived API session.
- Access tokens live for 10 minutes.
- Refresh requires a new nonce signature and an active device record.
- Only one device is active per account/pairing in the first release.
- Pairing a new device revokes the previous device immediately.
- Premium actions fail closed when the relay is unavailable; there is no offline entitlement cache granting Telegram bridge access.

### 4.3 Request protection

Every extension-to-relay mutation includes:

- device ID;
- timestamp;
- unique request ID;
- server nonce or short-lived session;
- body digest;
- device signature.

The relay enforces timestamp windows, nonce single use, idempotency, body-size limits, per-device rate limits, and schema validation.

### 4.4 Queue encryption

Telegram webhook payloads are plaintext when Telegram delivers them to the relay. The relay processes reply text transiently, encrypts it for the active device, and persists only the encrypted envelope. The envelope contains the ciphertext, ephemeral public-key material, command metadata, and expiration time.

This is encryption at rest against database disclosure; it is not end-to-end encryption from the Telegram client because the Bot API necessarily delivers plaintext to the bot backend. The privacy policy must state this accurately.

## 5. Data model

### 5.1 `accounts`

- `id` — internal account ID;
- `status` — active, blocked, deleted;
- `created_at`, `updated_at`.

An account may initially be created by successful Telegram pairing. A future payment identity attaches to the same account without changing conversation mappings.

### 5.2 `devices`

- `id`;
- `account_id`;
- signing public key;
- encryption public key;
- status;
- created/last-seen/revoked timestamps;
- extension version and release channel for diagnostics.

The extension ID is diagnostic metadata, not proof of authenticity.

### 5.3 `telegram_links`

- `account_id`;
- Telegram user ID;
- Telegram private chat ID;
- status;
- paired/last-seen timestamps.

### 5.4 `conversation_topics`

- `account_id`;
- opaque random relay mapping ID generated by the extension;
- Telegram thread ID;
- sanitized display label;
- created/last-event timestamps;
- state: active, archived, closed.

The raw Pure conversation identifier remains in extension-local storage. The relay stores only the opaque random mapping ID and returns that ID inside the device-encrypted reply envelope. The extension resolves it back to the local Pure conversation. Raw Pure conversation identifiers are never sent to the relay or written to server logs.

### 5.5 `delivery_queue`

- command ID;
- account/device ID;
- opaque conversation mapping ID;
- encrypted payload;
- created and expiry timestamps;
- attempt count;
- state: pending, claimed, delivered, failed, expired.

Message plaintext is never persisted. Delivered records are deleted immediately; expired records are deleted within the cleanup window.

### 5.6 `event_dedupe`

- account/device ID;
- event hash;
- creation timestamp.

No message body is stored. Rows expire automatically after a short deduplication window.

## 6. API surface

### Public/pairing

- `POST /v1/telegram/pairing/start`
- `POST /v1/telegram/webhook`
- `GET /v1/telegram/pairing/status/:code`

### Authenticated device

- `POST /v1/device/challenge`
- `POST /v1/device/session`
- `POST /v1/telegram/events`
- `GET /v1/telegram/queue`
- `POST /v1/telegram/queue/:id/ack`
- `POST /v1/telegram/disconnect`
- `POST /v1/device/heartbeat`

API responses use stable machine-readable error codes, including `PAIRING_EXPIRED`, `DEVICE_REVOKED`, `ENTITLEMENT_REQUIRED`, `RATE_LIMITED`, `PURE_UNAVAILABLE`, and `COMMAND_EXPIRED`.

## 7. Delivery and consistency

- Incoming extension events use at-least-once delivery with event-ID deduplication.
- Telegram replies are ordered per Pure conversation.
- Queue claim/ack operations are idempotent.
- A claimed item returns to pending if no acknowledgement arrives within the visibility timeout.
- Permanent Pure errors fail the item and notify the corresponding Telegram topic.
- Temporary browser/Pure errors retain the item until delivery or the 24-hour TTL.
- Telegram `429` responses respect `retry_after`; no busy retry loops are allowed.

## 8. Privacy and retention

The service processes message contents only to relay them.

- Pure-to-Telegram message bodies: transient memory only, discarded after Telegram acknowledgement.
- Telegram-to-Pure reply bodies: encrypted queue only, maximum 24 hours.
- Dedupe hashes: maximum 7 days.
- Operational logs: maximum 30 days and never contain message bodies, Telegram bot tokens, Pure tokens, raw authorization headers, or raw conversation identifiers.
- Disconnect/delete: revoke device sessions, delete pending payloads, and remove mappings in a documented cleanup flow.

The UI and privacy policy must disclose that Telegram stores relayed messages according to the user's Telegram account and Telegram's own policies.

## 9. Subscription model

The bridge launches as a free beta behind a server feature flag. The data model supports a future `telegram_bridge` entitlement without changing the extension protocol.

Proposed product boundary:

- free: local autoliker, local photo opener, basic local features;
- premium later: Pure in Telegram relay, multi-topic conversation UX, reliable queued replies, compatibility service, and future analytics/AI features.

The server checks entitlement on pairing, session creation, event relay, and queue access. A modified client cannot obtain the hosted bot/relay service without an active server entitlement.

## 10. MVP scope

### Included

- private Telegram bot chat with topics;
- one topic per Pure conversation;
- pairing through a one-time Telegram deep link;
- incoming text messages and new-match events;
- text replies from Telegram to Pure;
- encrypted 24-hour reply queue;
- one automatically replaceable active device;
- status, disconnect, privacy commands;
- deduplication, rate limiting, and delivery diagnostics;
- beta feature flag and future entitlement hook.

### Explicitly excluded

- server-side storage of conversation history;
- 24/7 Pure connectivity while the browser is closed;
- storage of Pure bearer tokens on the relay;
- MTProto authorization into the user's Telegram account;
- automatic creation of Telegram chat folders;
- voice, video, stickers, location, and arbitrary files;
- multi-device delivery;
- AI reply generation;
- cloud profile analytics.

Media support, AI features, and an always-on cloud connector require separate designs after the text relay proves demand and reliability.

## 11. Failure behavior

- Relay unavailable: local extension features continue; Telegram bridge shows offline and does not pretend messages were relayed.
- Telegram unavailable/rate-limited: the relay returns a retryable status without persisting the message body; the extension retains the bounded event locally and retries according to `retry_after`. User-visible failures are surfaced without leaking content to logs.
- Browser unavailable: Telegram replies wait encrypted for up to 24 hours.
- Pure session expired: extension reports `PURE_UNAVAILABLE`; queue items remain pending until TTL.
- Device replaced: old sessions receive `DEVICE_REVOKED`; new pairing becomes authoritative.
- Mapping missing: reply is rejected, the topic receives a recovery instruction, and no guessed Pure destination is used.
- Duplicate event/update: idempotency returns the prior outcome without sending twice.

## 12. Testing strategy

### Unit and contract tests

- event normalization and size limits;
- topic-title sanitization;
- pairing-code expiry and single use;
- signature and nonce verification;
- queue-envelope encryption/decryption;
- queue TTL and visibility timeout;
- dedupe and per-conversation ordering;
- Telegram webhook secret validation;
- Telegram and relay error-code mapping.

### Fixture tests

- recorded Pure incoming-message and match events;
- recorded user-initiated Pure send request used to validate the reply adapter;
- Telegram private-topic updates and replies;
- duplicated, delayed, reordered, and malformed updates;
- revoked-device and re-pairing flows.

### Integration tests

- Worker + isolated D1 database;
- fake Telegram Bot API server;
- extension background/content/page bridge harness;
- pairing through delivery and acknowledgement;
- browser-off queue followed by successful delivery;
- cleanup proving no plaintext remains after delivery/expiry.

### Manual beta validation

- Chrome Web Store build and unpacked build;
- Chrome restart and extension service-worker suspension;
- multiple Pure conversations and rapid replies;
- Telegram mobile and desktop clients;
- real Telegram `429` backoff behavior in a controlled test;
- privacy inspection of D1 rows and logs.

## 13. Rollout

1. Internal developer bot and test Telegram account.
2. Opt-in beta flag for a small group; inbound mirroring first.
3. Enable Telegram-to-Pure replies after the Pure send adapter is fixture-verified.
4. Add encrypted offline-browser queue and failure notices.
5. Expand beta while monitoring delivery latency, duplicates, queue expiry, and support incidents.
6. Consider paid entitlement only after retention and reliability demonstrate product value.

Rollback is server-controlled: disable `telegram_bridge` or only the outbound reply direction without affecting local extension features.

## 14. Success criteria

- Pairing succeeds without Telegram MTProto authorization or manual group creation.
- Every discovered Pure conversation maps deterministically to one Telegram topic.
- Incoming text reaches Telegram once under retries and duplicate events.
- Telegram replies reach the correct Pure conversation when the browser is available.
- Browser-off replies are delivered after return or deleted after 24 hours with a clear failure notice.
- No Pure bearer token or successfully relayed message body exists in D1 or operational logs.
- A copied or modified extension cannot use the hosted bridge without an active device session and server entitlement.
- Local extension functionality remains available when the relay is down.
