# Revive PSG1

Self-service software for converting a compatible PlaySolana PSG1 into a general-purpose Android gaming handheld. The primary product is a Netlify-hosted Chrome/Edge WebUSB wizard backed by a Fastify API on DigitalOcean App Platform. The signed Tauri desktop installers remain in the repository as deprecated recovery fallbacks.

> **Pre-beta / fail-closed.** Paid checkout, public downloads, and destructive installation remain disabled until the browser-proof suite, signing/provenance, restoration, dependency/legal work, and every launch gate pass. Do not distribute experimental images.

## What is implemented

- Read-only ADB → USB descriptor → Fastboot serial cross-check and stable SHA-256 device binding.
- Signed firmware-profile matching and unknown-firmware rejection.
- Signed ephemeral web sessions, a free WebUSB ADB/Fastboot identity scan, Wallet Standard checkout, exact 29 USDC construction, finalized verification, purpose-bound receipt-wallet installer authorization, one-use references, and device-bound licensing.
- Backend-approved, one-time beta invites bound to a scanned device and atomically capped at ten redemptions; `BICCSDEV` is an internal program label, not a public coupon.
- Recoverable device entitlement independent of the paying wallet, protected by a one-time-revealed, owner-saved recovery credential that the desktop never persists.
- Journaled allowlisted installer engine for `fastboot oem at-unlock-vboot`, validated fastbootd, vbmeta/system flashing, wipe, and reboot.
- Resume-capable, three-attempt artifact downloads with size and SHA-256 verification.
- Refund cutoff recorded immediately before destructive work, plus pre-modification refund requests.
- Netlify landing page, checkout, docs, privacy, and terms.
- DigitalOcean App Platform, PostgreSQL, Valkey, and Spaces configuration surfaces.

## Product limitations

- The PSG1 remains bootloader-unlocked after conversion.
- The device/ROM is not Google-certified; Play Integrity, banking, DRM, and some games may refuse to run.
- Revive does not distribute, proxy, or host the Play-enabled LineageOS image. The desktop verifies an owner-selected original-publisher archive and its extracted system image against exact signed release hashes before flashing it.
- Fingerprint is currently unvalidated and not guaranteed, so it is not a launch feature.
- echOS restoration depends on a verified official image for the matching PSG1 variant.
- Universal Android application compatibility is not promised.

## Repository

```text
apps/web       Next.js website, WebUSB wizard, and injected-wallet checkout (Netlify)
apps/api       Fastify API, Drizzle schema/migrations, Solana verification (DigitalOcean)
apps/desktop   Deprecated signed recovery fallback (Windows/macOS)
packages/contracts  Shared Zod schemas, messages, constants
profiles       Unsigned compatibility-profile source templates
tools          Offline signing utilities (private keys are never committed)
```

## Local development

Requirements: Node 22+, Rust stable, Android platform-tools, PostgreSQL 16, and Valkey/Redis 7.

```bash
npm install
cp apps/api/.env.example apps/api/.env
cp apps/web/.env.example apps/web/.env.local
npm run db:migrate
npm run db:seed -w @revive-psg1/api
npm run dev:api
npm run dev:web
npm run dev:desktop
```

The API intentionally reports devices as unsupported unless `RELEASE_PUBLIC_KEY_PEM` is configured and the database contains a matching active profile whose canonical JSON signature verifies.

## Verification

```bash
npm run typecheck
npm test
npm run build
cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml
```

CI repeats the Node checks and runs native Rust tests on both Windows and macOS. Desktop release builds additionally require:

- `REVIVE_RELEASE_PUBLIC_KEY_B64` embedded at Rust compile time.
- `REVIVE_LICENSE_PUBLIC_KEY_PEM` embedded at Rust compile time.
- Apple Developer ID/notarization credentials or Windows code-signing credentials.
- A Tauri updater signing key stored only in the CI secret store.

## Production deployment

See [founder alpha](docs/founder-alpha.md), [devnet payment testing](docs/devnet-payment-e2e.md), [deployment](docs/deployment.md), [security](docs/security.md), [checkout pairing](docs/checkout-pairing.md), [beta runbook](docs/beta-runbook.md), [operations](docs/operations.md), and [release process](docs/release.md). The essential order is:

1. Provision Managed PostgreSQL, Managed Valkey, and a private Spaces bucket.
2. Create separate runtime, migration, and read-only PostgreSQL roles; restrict trusted sources to the App Platform service and require CA-verified TLS.
3. Deploy `apps/api/.do/app.yaml`, apply migrations with the migration role, then run the idempotent seed.
4. Deploy the root repository to Netlify using `netlify.toml` and public-only `NEXT_PUBLIC_*` variables.
5. Upload signed private artifacts to Spaces and insert their separately signed release manifest.
6. Sign/notarize the desktop packages and publish them only after all eight launch-gate records carry reviewed evidence.

The treasury is fixed to `EAjkNpwau3hB58C2M4U8rQWFANHRidA8XiB4Dvq78T4y`. No treasury private key is needed or accepted by this system.

## Signing a profile or manifest

Keep the offline Ed25519 private key on an isolated signing machine. The helper writes the signed envelope to stdout and never writes the key:

```bash
REVIVE_OFFLINE_SIGNING_KEY_PEM="$(security find-generic-password -w -s revive-release-key)" \
  node tools/sign-document.mjs profiles/psg1-rk3588s-v11.template.json \
  > psg1-rk3588s-v11-api35-v1.signed.json
```

The checked-in profile is only a source template. Its firmware pattern must be widened only after read-only partition, bootloader, vendor, serial-uniqueness, controls, Wi-Fi, audio, storage, fingerprint, and restoration validation.
