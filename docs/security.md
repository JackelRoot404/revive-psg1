# Security model

## Trust boundaries

- The browser can request checkout actions but cannot issue licenses or decide compatibility.
- The API can issue online device licenses but cannot move treasury funds or sign firmware/releases.
- The desktop can scan and guide the user but cannot run the destructive engine without an embedded license key, embedded release key, device-matching license, signed profile/manifest, verified artifacts, and exact wipe phrase.
- Release, AVB, desktop-code-signing, and updater private keys are separate and offline or held by the relevant signing service.

## Device identity

The authoritative identifier is `SHA-256("revive-psg1:v1" || normalized_fastboot_serial)`. PSG1 exposes different ordinary USB/ADB descriptor serials across Android and Fastboot modes, so those mode-specific values are never used as the entitlement key. Before forming the identifier, the wizard reads the immutable Rockchip CPU `Serial` through ADB and requires it to equal the Fastboot protocol serial. The browser-reported Fastboot USB descriptor is compared and recorded, but Brave may return a cached Android-mode value for an already-paired device; a descriptor mismatch is therefore advisory only after the immutable CPU-to-protocol match succeeds. Native cohort diagnostics independently verify the actual operating-system Fastboot descriptor. Only the resulting domain-separated hash leaves the computer. Android installation IDs, mode-specific USB identifiers, host IDs, fingerprints, hostnames, and wallets are never entitlement keys.

The public launch gate remains closed if any beta serial is missing or duplicated. A second Rockchip/eFuse signal must be validated before changing this design.

The device hash is an identifier, not an authenticator. A read-only scan never issues a beta entitlement. A high-entropy Discord code is stored only as a digest, atomically binds to the first supported PSG1 that redeems it, and cannot be recovered, moved, or reused. A later browser session must reconnect and cross-check the same physical PSG1 before the API issues a new short-lived installer token. Codes and tokens are redacted from logs.

Private beta access likewise uses high-entropy `rpb_…` invites whose digests alone are stored. Each invite is manually seeded for one device hash, expires, is consumed atomically with its order, and still shares the hard ten-redemption database cap. `BICCSDEV` is only the internal beta-program bucket and is not accepted as a checkout credential.

## Payments

During free Early Access, `EARLY_ACCESS_FREE=true` makes the API issue zero-value `early_access` entitlements only after a supported, cross-checked physical-device web session. No wallet or payment proof is requested. The payment verifier and paid order routes remain unchanged and return to enforcement when the flag is false.

The web wizard proves its physical-device context by reading the immutable Rockchip CPU serial through ADB, then requiring it to match the Fastboot protocol before creating a signed ephemeral browser session. The browser USB descriptor comparison is retained as an explicit telemetry flag rather than an authority source. A supported stock-locked PSG1 may redeem one beta code; the API issues a two-hour installer token bound to the session, license, and device. The final destructive boundary requires a versioned no-recovery acknowledgement and exact wipe phrase.

After desktop proof, the browser discovers compatible Wallet Standard extensions injected into that browser. It accepts only Solana-mainnet accounts with message signing and legacy transaction signing, and exposes no address field, mobile QR, or wallet deep-link path. Wallet authorization signs a bounded domain/session/device/pairing-key challenge. The transfer then requires the same wallet.

The API verifies finalized success, payer signer, official mainnet USDC mint, exact 19,000,000 base-unit payer debit and treasury credit, unique order reference, and unused transaction signature. Screenshots and typed signatures are not payment evidence.

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
