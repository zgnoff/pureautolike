# Pure Tool Core and MCP — Design

**Date:** 2026-07-12

**Status:** Approved for implementation planning

## 1. Objective

PureAutoLike will expose a complete, reusable catalog of actions covering Pure and the PureAutoLike browser extension. The same operations will serve AI agents through MCP, the product application through an internal API, Telegram workflows, and future clients.

MCP is an interface over the product core, not the location where Pure behavior is implemented. Pure protocol knowledge, validation, authorization, routing, and normalized results live in a shared `Pure Tool Core`.

The target catalog covers every observable Pure action. An operation becomes executable only after its real Pure request and response protocol has been captured, sanitized, tested, and added to the allowlisted adapter. Unknown operations are advertised as unavailable rather than guessed.

## 2. Product principles

1. Users and agents see one coherent tool catalog.
2. Server-capable operations continue while the browser is closed.
3. Browser-only operations clearly report that the extension is offline.
4. Pure credentials, cookies, authorization headers, and protected media URLs never appear in MCP results or model context.
5. Irreversible and account-sensitive actions require explicit user confirmation.
6. The product application calls the core directly; it does not depend on MCP as an internal transport.
7. Every state-changing request is authorized, validated, idempotent where possible, and auditable without recording private message content.

## 3. Architecture

```text
AI agents          Product app          Telegram workflows
    |                   |                       |
    +-------- MCP / internal API / jobs -------+
                        |
                 Pure Tool Core
        schemas | policy | registry | routing
                        |
              Execution coordinator
                /                  \
        Cloud gateway           Extension bridge
          Pure API               Browser and UI
             24/7             while extension is online
```

### 3.1 Pure Tool Core

The core owns:

- canonical tool definitions and versioned input/output schemas;
- capability discovery and availability state;
- input validation and output normalization;
- permission and confirmation policy;
- executor selection;
- idempotency, bounded retries, and privacy-safe audit events;
- mapping stable product operations to versioned Pure adapter methods.

The core contains no UI and no MCP-specific business logic.

### 3.2 Pure protocol adapter

The adapter is the only module that knows Pure endpoint paths, payload fields, response shapes, event polling, media authorization, and protocol versions. Each operation is allowlisted and backed by sanitized fixtures.

The adapter never accepts an arbitrary URL, HTTP method, header set, or request body from an MCP caller. This prevents the MCP surface from becoming an unrestricted authenticated HTTP proxy.

### 3.3 Cloud gateway executor

The existing long-running gateway is the preferred executor for operations that can run from authenticated Pure API access. It supports 24/7 discovery, chat synchronization, history, profile retrieval, media transfer, messaging, and account operations as their protocols become available.

The gateway owns decrypted session use in memory, Pure rate-limit handling, session renewal, ordered execution, and reconciliation. It never returns raw session material to the core or clients.

### 3.4 Extension executor

The extension bridge executes browser-dependent operations:

- starting, stopping, and configuring the autoliker;
- reading runner and tab state;
- opening Pure UI surfaces or protected media when browser context is required;
- collecting or renewing an authenticated session under the existing security boundary;
- controlling extension Telegram integration and local diagnostics;
- performing actions whose protocol is not safely available to the cloud executor but is implemented in the extension.

The extension maintains a presence lease. Commands fail with `extension_offline` when no current authenticated lease exists.

### 3.5 MCP server

The MCP server exposes authorized core operations as tools and exposes capability metadata as resources or read-only discovery tools. It authenticates the caller, binds the caller to one product account, attaches a permission grant, and forwards canonical calls to the core.

MCP responses are bounded and structured. Large histories, media files, and exports use pagination, transfer handles, or application-managed artifacts rather than unbounded inline content.

### 3.6 Product application API

The application uses the same core through an authenticated internal API or in-process module. It receives the same normalized result and error contracts as MCP but may render confirmations, progress, and media through product-specific UI.

## 4. Tool catalog

Tool names use stable product concepts rather than Pure endpoint names.

### 4.1 `pure.discovery.*`

- get discovery state and preferences;
- get the current or next profile;
- inspect a profile and its complete declared photo list;
- like, skip, or perform other captured feed reactions;
- start, pause, resume, and stop bounded discovery workflows;
- report discovery progress and provider rate limiting.

### 4.2 `pure.matches.*`

- list matches and incoming/outgoing reactions;
- inspect match state;
- perform captured match actions;
- block, report, unmatch, or remove only with explicit confirmation.

### 4.3 `pure.chats.*`

- list every accessible chat;
- inspect one chat and its participant profile;
- paginate complete accessible history with deduplication;
- read new events and reconcile gaps;
- send supported message kinds;
- mark read when the real Pure protocol and caller policy permit it;
- delete or clear only with explicit confirmation.

### 4.4 `pure.media.*`

- list declared profile photos without scraping the discovery feed;
- retrieve a specific authorized profile or chat photo;
- download and upload captured photo, voice, audio, and video kinds;
- expose metadata and transfer status without leaking protected origin URLs;
- return a labeled unsupported or expired-media result instead of silently dropping content.

### 4.5 `pure.profile.*`

- read the authenticated account profile and settings;
- update captured editable profile fields;
- manage profile photos through captured upload, order, and deletion protocols;
- read and update discovery location or travel-mode settings when supported;
- require confirmation for identity, location, visibility, and destructive changes.

### 4.6 `pure.session.*`

- report connection, authentication, renewal, and compatibility state;
- activate, rotate, reconnect, revoke, and delete the cloud session;
- report safe capability degradation without exposing credentials.

### 4.7 `extension.autolike.*`

- get status and configuration;
- start, pause, resume, and stop;
- set bounded timing, limits, filters, and schedules;
- return runner statistics and privacy-safe failures.

### 4.8 `extension.telegram.*`

- get pairing and synchronization status;
- connect, test, pause, resume, and disconnect synchronization;
- report topic mappings, import progress, and delivery failures without returning bot secrets.

### 4.9 `extension.browser.*`

- report extension, browser, Pure tab, login, and runner availability;
- focus or open a Pure tab when user policy permits;
- request a browser-dependent operation and report whether user interaction is required.

### 4.10 `system.*`

- list catalog versions, permissions, and current capabilities;
- get executor health and compatibility status;
- inspect one operation by request ID using privacy-safe metadata;
- cancel a cancellable workflow;
- request and resolve confirmation challenges.

The initial release need not implement every catalog entry. It must expose accurate availability for the complete catalog and never claim that an unimplemented operation succeeded.

## 5. Capability registry and routing

Each registered operation declares:

- stable name and schema version;
- supported executor set: `gateway`, `extension`, or both;
- required permission scopes;
- confirmation class;
- idempotency and retry behavior;
- fixture-backed Pure protocol version;
- availability and degradation reason;
- size, time, pagination, and media limits.

Routing rules:

1. Use the gateway for 24/7-capable operations when its session is healthy.
2. Use the extension for extension control and browser-only operations.
3. When both executors are valid, prefer the gateway unless browser context materially improves correctness or the caller explicitly requests interactive execution.
4. Retry on the alternate executor only when the operation declares safe failover and no uncertain mutation occurred.
5. Return an explicit availability error when no authorized executor is available.

## 6. Authorization and confirmation

Permission grants are scoped by account and tool family. Suggested scopes are:

- `pure:read`;
- `pure:react`;
- `pure:message`;
- `pure:media`;
- `pure:profile:write`;
- `pure:account:dangerous`;
- `extension:control`;
- `telegram:control`.

Read operations require authorization but no interactive confirmation. Likes, ordinary messages, and bounded autoliker control may run without per-call confirmation when the user has explicitly granted the corresponding scope.

Blocking, reporting, unmatching, deleting chats or media, changing identity/location/visibility settings, revoking sessions, and deleting account data require a short-lived confirmation challenge bound to the exact account, operation, normalized arguments, and caller. A confirmation cannot authorize changed arguments or be replayed.

## 7. Request and result contracts

Every call receives a generated `request_id`, caller identity, account binding, permission grant, optional idempotency key, and optional confirmation token.

Successful result:

```json
{
  "ok": true,
  "data": {},
  "executor": "gateway",
  "request_id": "req_example",
  "capability_version": "1"
}
```

Failed result:

```json
{
  "ok": false,
  "error": "extension_offline",
  "message": "The browser extension is not currently connected.",
  "retryable": true,
  "request_id": "req_example"
}
```

Stable error codes include:

- `invalid_input`;
- `permission_denied`;
- `confirmation_required`;
- `extension_offline`;
- `gateway_offline`;
- `reauth_required`;
- `capability_not_implemented`;
- `provider_rate_limited`;
- `provider_rejected`;
- `media_expired`;
- `compatibility_required`;
- `result_too_large`;
- `operation_uncertain`.

Provider response bodies, credentials, private URLs, and raw internal exceptions are not included in external errors.

## 8. Workflows and long-running operations

Bulk history import, autoliking, continuous event synchronization, multi-photo transfer, and large exports are workflows rather than long blocking MCP calls.

A workflow start tool returns a bounded job descriptor. Status and cancellation use `system.*` tools. Progress records contain counts, safe states, rate-limit delays, and bounded errors. A job checkpoint survives gateway restart when the workflow is server-side.

Cancellation is cooperative. It stops future work but does not claim to reverse provider mutations that already succeeded.

## 9. Data and media handling

- Chat and profile lists are paginated.
- History deduplicates by provider identifiers and checkpoints oldest/newest watermarks.
- Profile-photo retrieval starts from a specific user or match identifier and the profile response's declared photo array. It never downloads all discovery-feed images.
- Protected media is streamed through an authorized executor or represented by a short-lived opaque transfer handle.
- Raw media URLs are never sent to an AI model.
- Temporary media follows the existing bounded encrypted-spool and deletion policy.
- Message text and media bodies are not written to operational logs.

## 10. Extension communication

The extension establishes an authenticated outbound channel to the control plane and renews a short presence lease. The server never opens a public inbound port on the user's computer.

Commands include a request ID, account and device binding, schema version, expiration, and idempotency key. The extension validates the operation against its local allowlist before execution and returns a normalized result. Expired, duplicated, unknown, or cross-account commands fail closed.

## 11. Observability and privacy

Audit events may contain:

- request ID, tool name and schema version;
- account-scoped opaque identifier;
- caller type and granted scope;
- selected executor;
- timing, result code, retry count, and confirmation state.

They exclude message bodies, profile text, media, raw Pure identifiers, Telegram bot credentials, Pure credentials, cookies, authorization headers, and protected URLs.

Metrics cover availability, latency, error rates, provider rate limits, compatibility failures, queue depth, and workflow progress by tool family and executor.

## 12. Failure behavior

- Validation and permission failures do not reach an executor.
- Provider `429` responses honor retry timing and surface bounded progress.
- Unknown response schemas put the operation into `compatibility_required`.
- A state-changing timeout without a definitive provider response returns `operation_uncertain`; it is not automatically replayed unless reconciliation proves that it is safe.
- Extension disconnects expire pending browser commands rather than executing stale actions after reconnect.
- Gateway and extension results are deduplicated by request and provider identifiers when safe.

## 13. Testing

Required automated coverage:

- registry schema validation and unique tool names;
- permission and confirmation matrices;
- executor routing, safe failover, and offline errors;
- sanitized Pure fixtures for every implemented adapter method;
- rejection of arbitrary URLs, methods, headers, and unregistered payloads;
- idempotency, uncertain mutations, cancellation, and bounded retries;
- history pagination and deduplication;
- profile photo targeting without discovery-feed scraping;
- extension lease authentication, expiry, and account isolation;
- MCP-to-core and application-to-core contract parity;
- scans proving credentials, private URLs, messages, and media are absent from logs and model-facing results.

Controlled live tests use one owner-controlled account before any multi-user rollout.

## 14. Delivery sequence

### Phase 1 — Foundation

- extract canonical Pure Tool Core interfaces;
- implement capability registry, schemas, permission policy, confirmation contract, result/error contract, and executor router;
- connect gateway and extension health without enabling new Pure mutations.

### Phase 2 — Read and extension control

- MCP authentication and tool exposure;
- `system.*`, `pure.session.*`, read-only profile/chat/history operations;
- extension status and autoliker start/stop/configuration;
- application API parity.

### Phase 3 — Profile photos and inbound synchronization

- targeted complete profile-photo list;
- authorized media transfer;
- chat import, event polling, deduplication, and Telegram forwarding.

### Phase 4 — Messaging and media mutations

- outgoing text after sanitized send fixtures;
- outgoing photos, voice, audio, and video only after each protocol is captured;
- read state and ordered reconciliation.

### Phase 5 — Complete catalog

- remaining observed Pure settings, profile, reaction, moderation, session, and account operations;
- dangerous-action confirmations;
- catalog completeness audit against the Pure UI and sanitized endpoint inventory.

## 15. Acceptance criteria

The design is implemented successfully when:

1. MCP, the application, and Telegram workflows use the same canonical operation definitions.
2. Capability discovery accurately reports every catalog operation as available, degraded, or not yet implemented.
3. Server-capable tools continue with the browser closed, while browser-only tools return `extension_offline`.
4. No model-facing or logged payload exposes Pure or Telegram secrets, protected URLs, message bodies, or media.
5. Irreversible operations cannot execute without a valid bound confirmation.
6. Implemented Pure operations are fixture-backed and fail closed on unknown schemas.
7. The complete-catalog audit maps every observable Pure UI action to a registered tool or an explicit unsupported capability record.
