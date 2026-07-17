# Same-computer checkout pairing

An injected wallet extension proves control of a wallet; it does **not** prove that the checkout browser is on the computer connected to the PSG1. A checkout URL can be copied. Revive therefore requires a separate desktop-local proof before the API will issue a wallet challenge.

## Protocol

1. Revive Desktop creates the session with an ephemeral Ed25519 pairing key and opens the checkout URL. The checkout bearer is in the URL fragment so it is not sent in Netlify request logs.
2. The page moves the bearer to in-memory state and `sessionStorage`, immediately removes the fragment, generates a cryptographically random 32-byte browser nonce, and sends it to `POST /v1/sessions/{id}/browser-proof/challenge`.
3. The API returns a signed-message-shaped challenge containing the production domain, challenge ID, session ID, device hash, desktop public key, SHA-256 of the browser nonce, server nonce, and five-minute expiry. The raw browser nonce stays in the initiating browser/API exchange.
4. The page base64url-encodes that exact UTF-8 message and invokes `revive-psg1://browser-proof?message=...`.
5. Desktop parses the message, rejects unknown fields/order/domain/session/device/key, verifies the nonce/expiry against its live pairing state, and asks the user to continue.
6. Desktop signs the exact message and sends `{challengeId, signature}` directly to `POST /v1/sessions/{id}/browser-proof/verify` using its desktop-session bearer.
7. The original page polls `POST /v1/sessions/{id}/browser-proof/status` using the checkout bearer plus the exact challenge ID and browser nonce. After `verified:true`, the API returns a short-lived browser-bound token. The page erases the checkout bearer, nonce, and challenge from `sessionStorage`.
8. Both `/v1/wallet/challenge` and `/v1/wallet/verify` require that browser-bound token; the original checkout token is rejected. A copied URL therefore cannot race wallet authorization from another browser instance.

The desktop signature never passes through the website, URL, wallet, clipboard, or Netlify. The checkout bearer is never placed in a query string or sent to the desktop protocol handler.

## Required tests before enabling checkout

- Copied checkout URL on a second computer cannot reach wallet authorization.
- Wrong/closed desktop session, wrong device, key, domain, nonce, field order, or expired challenge fails.
- Challenge and signature replay fail after one successful verification.
- A copied token or second tab with a different browser nonce cannot read proof status or obtain a browser token. Racing the same challenge produces only one successful verification.
- Custom-protocol message mutation and base64url decoding errors fail closed.
- Browser refresh before proof can resume from same-tab `sessionStorage`; closing the tab requires a new desktop checkout.
- No checkout bearer or proof appears in browser history, Netlify logs, API logs, crash reports, analytics, or referrer headers.
- Wallet switch after authorization clears browser wallet state and requires reauthorization.

`SAME_COMPUTER_PAIRING_IMPLEMENTED` in `apps/web/lib/public-config.ts` remains `false` for production builds until these tests pass end-to-end on signed Windows and macOS packages.
