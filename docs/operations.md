# Operations runbook

## Service health

- Netlify serves marketing/docs/checkout; DigitalOcean serves `/healthz` and the API; Spaces serves presigned artifacts.
- Alert on failed deployments/domains, API restarts/memory, P95 above 500 ms, sustained 25 requests/second/instance, PostgreSQL/Valkey availability, RPC failures, payment replay conflicts, license spikes, promo exhaustion attempts, and signature/hash failures.
- A healthy `/healthz` is necessary but not proof that PostgreSQL, Valkey, both RPC providers, signing, and Spaces work. Run a non-destructive synthetic session/status check separately.

## Outage behavior

- If both Solana RPC providers fail, verification fails closed. Users with a submitted transaction must see “do not pay again” and retry the same signature later.
- If artifact storage/signing/profile verification fails, stop new installation starts. Never replace an object under an existing signed key/hash.
- If the database is unavailable, disable public sales and preserve existing devices locally; do not issue offline substitute licenses.
- If Netlify is compromised, disable its deploy, rotate checkout/session secrets, invalidate active short-lived state, inspect CSP/build provenance, and keep API CORS restricted. Treasury funds cannot be moved by website/backend keys.

## Refund request

1. Authenticate the device license through Desktop; do not accept screenshots or manually pasted license tokens.
2. Confirm order is paid rather than promo and inspect `modification_started_at`.
3. Before the boundary, approve through the audited operator procedure, send USDC from the offline-controlled treasury process, record the finalized refund signature, revoke the entitlement, and append the audit event.
4. After the boundary, route only verified incompatibility cases to manual review. Preserve diagnostics and restoration result.
5. Reconcile treasury and database daily while refunds are open. The application never stores a treasury private key.

The current repository has a customer refund-request endpoint but no authenticated operator approval surface. Public launch is blocked until an audited approval/rejection procedure and database transition are implemented and tested.

## Database and storage drills

- Daily backups/PITR per the selected PostgreSQL plan; quarterly restore into a disposable isolated cluster.
- Monthly Valkey loss test: short-lived sessions may disappear, but no paid order, license, or audit event may depend solely on Valkey.
- Monthly private-object/presigned-URL test, including expiry, range requests, three-attempt resume, and exact local SHA-256.
- Never log database URLs, CA PEM, wallet/session/license bearers, pairing proofs, raw serials, unrestricted ADB output, Spaces credentials, or signing keys.

## Key incident

- Online license key: disable issuance, rotate key ID/key, retain old public key only for a reviewed transition, and audit licenses issued during exposure.
- Offline release/AVB key: halt all downloads and installs; do not silently rotate. Publish an incident notice and a separately verified trust-transition release.
- Desktop code-signing/updater key: revoke through Apple/Microsoft/Tauri channels, disable download links, and require a clean, independently reviewed rebuild.
