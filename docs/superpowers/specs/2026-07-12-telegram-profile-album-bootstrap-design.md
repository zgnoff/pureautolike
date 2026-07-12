# Telegram Profile Album Bootstrap Design

Date: 2026-07-12
Status: approved for implementation planning

## Objective

When a Pure conversation first appears in the hosted Telegram bridge, give the
user visual context for that conversation by sending every available photo from
the peer's Pure profile album into the mapped Telegram topic. Topic creation and
new text delivery must not wait for an album response.

The feature must never infer profile ownership from a generic image request or
from a CDN filename. It must be impossible for feed images, application assets,
other users' albums, or self-destructing chat media to enter the profile-album
bootstrap path.

## Evidence And Protocol Boundary

The 2026-07-12 endpoint capture proves that `GET /chats` returns:

- a stable chat/channel identifier;
- participants with stable user identifiers;
- an album marked `privacy=profile`;
- `photoCount` and `mainPhoto` metadata;
- profile-photo URLs hosted by `cdn.thepure.app`.

The same capture does not prove a full peer-album listing endpoint. The
implementation may ship main-photo support from the proven `/chats` shape, but
must not invent an endpoint for the remaining photos. Full-album retrieval is
enabled only after a sanitized capture proves the exact request and response
shape for the peer's `privacy=profile` album.

## Safety Invariants

1. A photo candidate is accepted only when its metadata descends from a
   `privacy=profile` album belonging to the peer participant of the same chat.
2. The account's own participant is excluded using the current Pure user ID.
3. The chat ID, peer user ID, album ID, and photo ID association is established
   from one validated Pure response. Loose matching across unrelated network
   events is forbidden.
4. Only HTTPS URLs with the exact hostname `cdn.thepure.app` are accepted for
   the captured protocol version. Redirects to a different hostname fail
   closed.
5. Generic `Image` events, feed endpoints, avatar assets, application assets,
   `self_destructed` albums, message attachments, and unbound URLs never enter
   this flow.
6. The accepted photo count cannot exceed both the album's declared
   `photoCount` and the application limit of 50 profile photos per album. A
   malformed or excessive album fails closed instead of partially consuming
   arbitrary images.
7. Raw profile-photo URLs and bytes are transient. D1 stores only routing data,
   status, and hashes needed for idempotency.

## Data Flow

### 1. Conversation metadata

The content-side Pure response parser maintains an in-memory map:

```text
threadId -> peerUserId, profileAlbumId, declaredPhotoCount, validated photos
```

`GET /chats` can seed the mapping and its proven main photo. A future captured
peer-album response can replace the partial photo set with the complete,
validated set.

The map is bounded and contains metadata only. It is not populated from the
general endpoint logger or DOM image discovery.

### 2. Bridge event contract

The extension sends a dedicated authenticated `profile_album` event containing:

- opaque conversation mapping ID;
- opaque event ID;
- album state: `pending`, `ready`, or `none`;
- declared photo count;
- validated photo descriptors containing an opaque photo ID and an allowlisted
  HTTPS URL.

The event contains no Pure user ID, raw chat ID, profile name, authorization
header, or cookie. The existing opaque mapping remains the routing boundary.

### 3. Topic and ordering behavior

- New message delivery creates the Telegram topic immediately if needed.
- If a validated album is already available, its photos are sent before the
  triggering text message.
- If the album is still pending, text delivery proceeds and photos are appended
  when the validated album event arrives.
- A `none` state sends exactly one `Фотографий профиля нет` service message.
- A missing or failed album lookup remains `pending`; it must not be mislabeled
  as an empty profile.

This preserves live-message availability while making the album the first
context block whenever the data is already available.

### 4. Telegram delivery

- One photo uses `sendPhoto`.
- Multiple photos use `sendMediaGroup` in batches of 2-10 photos. A final
  one-photo remainder uses `sendPhoto`.
- The Worker validates every descriptor again before calling Telegram.
- Each photo gets an idempotency hash derived from account, mapping, album, and
  opaque photo ID.
- Successfully delivered photos are never resent after duplicate events or
  extension restarts.
- On a partially failed multi-batch delivery, only unacknowledged photos remain
  retryable.

## Failure Behavior

- Invalid ownership, album privacy, URL host, count, or descriptor shape returns
  a stable validation error and performs zero Telegram media calls.
- Telegram rate limits return a bounded `retry_after` signal without losing
  text delivery.
- A CDN or Telegram media failure does not prevent later Pure text messages from
  reaching the topic.
- No raw provider response, URL, identifier, token, or message body is written
  to logs or D1 error fields.
- Explicit `none` is idempotent and produces at most one service message per
  conversation mapping.

## Persistence

The existing conversation-topic mapping remains authoritative. The feature
reuses `bridge_event_dedupe` with one event hash per account, opaque mapping,
album, and opaque photo ID. The Worker claims each photo before its Telegram
call, retains successful claims, and removes claims for a failed batch so only
unacknowledged photos are retryable.

No new persistence table is required. No URL, image bytes, Pure user ID, or raw
chat ID may be persisted.

## Tests

The implementation is accepted only when tests prove:

1. A validated `privacy=profile` album is routed only to its conversation topic.
2. A stream containing 10,000 feed and application images produces zero profile
   album events and zero Telegram media calls.
3. A mismatched peer user, album ID, mapping ID, non-profile privacy value, or
   URL hostname is rejected before delivery.
4. An explicitly empty profile produces one
   `Фотографий профиля нет` message.
5. A pending or failed lookup does not produce the empty-profile message.
6. Duplicate album responses and extension restarts do not duplicate photos.
7. Large valid albums are split into bounded Telegram media groups.
8. Partial batch failure retries only unacknowledged photos.
9. Album failure and Telegram rate limiting do not block new text messages.
10. Existing text-only, legacy Telegram, pairing, topic, privacy, and cloud
    gateway tests remain green.

## Delivery Phases

### Phase A: Proven main photo

Implement the full safety boundary and delivery pipeline using only the
`mainPhoto` metadata already proven in `/chats`. This validates ordering,
idempotency, Telegram delivery, and feed-image exclusion without inventing Pure
protocol behavior.

### Phase B: Complete profile album

Capture and sanitize the exact peer profile-album request and response. Extend
the same validator to accept every photo from that explicit album and enable
multi-photo delivery. Phase B must reuse Phase A's ownership, host, persistence,
and idempotency boundaries.

## Non-Goals

- Naming topics from inferred profile names.
- Importing feed images, avatars, chat attachments, or self-destructing media.
- Sending inbound chat photos or voice messages; those remain a separate message
  media pipeline.
- Delaying new text delivery while waiting for profile metadata.
- Persisting profile images or Pure CDN URLs.
