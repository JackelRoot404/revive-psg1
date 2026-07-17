# Security model

## Trust boundaries

- The browser can request checkout actions but cannot issue licenses or decide compatibility.
- The API can issue online device licenses but cannot move treasury funds or sign firmware/releases.
- The desktop can scan and guide the user but cannot run the destructive engine without an embedded license key, embedded release key, device-matching license, signed profile/manifest, verified artifacts, and exact wipe phrase.
- Release, AVB, desktop-code-signing, and updater private keys are separate and offline or held by the relevant signing service.

## Device identity

The authoritative identifier is `SHA-256("revive-psg1:v1" || normalized_fastboot_serial)`. Before forming it, the desktop requires the normalized Fastboot serial to equal the stock/recovery ADB serial and to appear in the USB descriptor report. Only the hash leaves the computer. Android IDs, host IDs, fingerprints, hostnames, and wallets are never entitlement keys.

The public launch gate remains closed if any beta serial is missing or duplicated. A second Rockchip/eFuse signal must be validated before changing this design.

The device hash is an identifier, not an authenticator. A read-only entitlement lookup never issues a license token. Initial claim generates a high-entropy `rpr_…` recovery credential in the desktop app, stores only its SHA-256 digest in PostgreSQL, and shows it once to the owner. The credential is kept only in process memory while the claim is in flight and is never written to the desktop data directory. Another computer must reconnect the matching physical PSG1 and manually present the owner-saved credential through an authenticated desktop session. The paying wallet is not required. The local desktop cache persists only its signed license token with user-only file permissions where the host supports POSIX modes. Credentials and tokens are redacted from logs. Because the owner declined OS-keychain integration, the signed local token is not protected from malware running as the same OS user; public documentation must state that limitation.

Private beta access likewise uses high-entropy `rpb_…` invites whose digests alone are stored. Each invite is manually seeded for one device hash, expires, is consumed atomically with its order, and still shares the hard ten-redemption database cap. `BICCSDEV` is only the internal beta-program bucket and is not accepted as a checkout credential.

## Payments

An injected wallet alone does not prove the browser is on the initiating computer because a checkout URL can be copied. Before wallet authorization, the browser supplies a fresh browser-instance nonce, invokes Revive Desktop with the bounded challenge, and polls while Desktop signs and submits proof directly to the API. The proof signature never enters the browser. The API issues a browser-bound token only when the checkout token, challenge ID, and browser nonce match; wallet endpoints reject the original checkout token. See [checkout pairing](checkout-pairing.md).

After desktop proof, the browser discovers compatible Wallet Standard extensions injected into that browser. It accepts only Solana-mainnet accounts with message signing and legacy transaction signing, and exposes no address field, mobile QR, or wallet deep-link path. Wallet authorization signs a bounded domain/session/device/pairing-key challenge. The transfer then requires the same wallet.

The API verifies finalized success, payer signer, official mainnet USDC mint, exact 29,000,000 base-unit payer debit and treasury credit, unique order reference, and unused transaction signature. Screenshots and typed signatures are not payment evidence.

## Logs and reports

Fastify redacts authorization, signatures, pairing proofs, and transaction signatures. Audit actors are domain-separated hashes. Crash stacks remove base58-like secrets and 64-character hashes. Compatibility reports use the approved schema and must not include raw serials or unrestricted ADB logs.

## Known pre-release requirements

- Keep high/critical dependency findings at zero and review the lockfile before each release. The legacy Solana/wallet-adapter dependency chain has been removed. As of the current lockfile, `npm audit` reports no high/critical findings; its remaining moderate findings are the latest stable Next.js package's pinned PostCSS and API-only Drizzle/esbuild development tooling. Track upstream fixes instead of forcing incompatible dependency downgrades.
- Add an authenticated operator surface or audited SQL runbook for refund resolution and launch-gate evidence.
- Pen-test pairing/deep-link replay, RPC inconsistencies, signed-JSON canonicalization, presigned URL leakage, updater rollback, and local journal tampering.
- Verify end-to-end echOS restoration using customer-supplied official images.
- Resolve Google Play/GMS redistribution and trademark rights before including those binaries or claims in a commercial release.
- Pin every GitHub Action to a reviewed full commit SHA and configure branch/environment protection before credentialed release automation is added.
- Commission legal review for terms, privacy retention, support identity, jurisdiction, warranty, tax, and refund handling.
