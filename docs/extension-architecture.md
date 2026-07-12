# PureAutoLike Extension Architecture

PureAutoLike is a browser extension with three runtime layers:

- `src/content.js`: owns DOM scanning, like clicks, profile text capture, badge UI, and popup-facing status. It does not store or use the Pure bearer token.
- `src/page-bridge.js`: runs in the Pure page context so it can observe Pure network calls, derive token readiness/user id, collect network events, and fetch protected photo blobs. It never posts the bearer token back to the content script.
- `src/background.js`: owns privileged browser APIs such as debugger clicks, Telegram sends, single-runner tab lock, tab closing, and `chrome.alarms` timers.

## Runtime Boundaries

- Autoliker stop and tab-close timers are scheduled in `background.js` through browser alarms. Content timers exist only as a fallback for browsers without alarms.
- Only one Pure tab can own the runner lock. Duplicate tabs can read status, but they cannot start a second autoliker while the first owner is live.
- Profile captures are stored without an app-side count limit. The popup reads the lightweight capture index every second and loads full captures only for export.
- Engagement event detection is bounded in content runtime, while Telegram send
  dedupe and counters live in `background.js` so bot credentials are not sent to
  the content script.
- Chat history responses/events are baselined per thread before they can emit
  message notifications. This prevents duplicate tabs from replaying already
  visible old Pure messages to Telegram.

## Security Notes

- The page bridge can see Pure request headers because it runs in the page context. That bearer token must stay inside the bridge.
- Content asks the bridge for `hasToken`, `userId`, network events, and photo
  blob URLs. For photo opening, content marks the clicked DOM root with a request
  id and the bridge derives metadata from that page DOM node; content does not
  send raw photo metadata and must not receive the raw bearer token.
- Telegram credentials live in extension local storage and are sent only from `background.js` to Telegram Bot API.

## Pure Tool Core Boundary

`backend/pure-tool-core` defines canonical operations, schemas, permissions,
confirmation requirements, capability availability, result contracts, and executor
routing shared by MCP, the application, Telegram workflows, and the cloud gateway.

The core contains no Pure endpoint paths, bearer tokens, cookies, protected media
URLs, browser APIs, Telegram credentials, or MCP transport code. Pure protocol
knowledge belongs in fixture-backed gateway or extension executors. Operations
without a captured and sanitized protocol remain registered as
`capability_not_implemented`.
