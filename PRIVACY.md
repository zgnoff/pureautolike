# PureAutoLike Privacy Policy

Last updated: 2026-06-21

PureAutoLike is a browser extension for users who run Pure Web in their own
browser profile. It automates visible like clicks, opens hidden Pure photos when
the active Pure web session already has access, can send optional Telegram
alerts, and can export locally collected profile notes when the user enables
that feature.

## Data Processed In The Browser

PureAutoLike runs content scripts only on `https://pure.app/*`. Inside that page,
the extension may process visible Pure page content, visible profile text,
buttons, photo placeholders, chat and match events, and user interaction state
needed to operate the extension.

The extension stores settings in browser extension storage. These settings can
include feature toggles, local counters, Telegram notification settings, and a
locally generated installation id for beta/license checks.

If Telegram notifications are enabled, the Telegram bot token and chat id entered
by the user are stored in local browser extension storage and are sent to the
Telegram Bot API only to send test notifications or selected Pure event alerts.

If local profile capture is enabled, visible profile status, age, descriptions,
capture timestamps, and the current Pure page URL are stored locally in browser
extension storage. They are exported only when the user clicks the Markdown
export button and can be cleared by the user.

The Pure authorization header can be observed inside the active Pure page at
runtime so the hidden photo opener can make Pure API/CDN requests already
available to the logged-in web session. This value is kept in page memory for
that runtime task and is not stored in extension settings.

## Data Sent To PureAutoLike Services

The extension contacts the PureAutoLike license endpoint to support beta access
now and paid access in the future. License requests may include:

- a locally generated installation id;
- the extension id;
- the extension version;
- the release channel.

If paid access is enabled later, subscription checks may also use an email
address or payment customer id that the user provides through the payment flow.
PureAutoLike does not process payment card numbers directly.

The separately consented cloud gateway test processes an encrypted Pure credential envelope.
The browser encrypts the active session credential to the
gateway's pinned public key; the gateway holds the corresponding private key
and decrypts the envelope only in gateway memory to operate the user's Pure
session. PureAutoLike does not ask for or receive the user’s Pure password.
This is server-side encrypted transport, not end-to-end encryption, because the
gateway must use the session credential after decryption.

Cloud test traffic leaves from a shared server IP. Pure may associate that
shared server IP with multiple test accounts, restrict those accounts, or block
them. During the controlled test, access is limited to owner-operated test accounts
that explicitly accept this risk; it is not enabled for general users.

The current gateway foundation does not enable Telegram-to-Pure sending. If a
future encrypted Telegram-to-Pure command queue is activated, queued commands
have a fixed 24-hour expiry and are deleted after expiry or destructive cloud
disconnect. Queue payloads remain encrypted outside the active gateway process.

## Data Sent To Third Parties

PureAutoLike sends data to third parties only for core extension features:

- Pure Web and Pure API/CDN endpoints are used inside the active Pure web
  session to operate the page and open photos already available to that session.
- Telegram Bot API is used only when the user enables Telegram notifications.
- A payment provider may be used later for paid subscription checkout.

PureAutoLike does not sell user data. PureAutoLike does not use user data for
advertising, creditworthiness, lending, or unrelated profiling.

## Remote Code

The extension does not execute remote JavaScript or WebAssembly. Extension code
is packaged with the browser extension. Network responses are used as data for
extension features and license status, not as executable code.

## User Control

Users can disable Telegram notifications and local profile capture at any time
from the extension popup. Users can clear locally captured profile notes from the
popup. Users can remove all extension-local data by uninstalling the extension
or clearing the extension's browser storage.

## Contact

For support or privacy questions, use GitHub Issues:
https://github.com/zgnme/pureautolike/issues
