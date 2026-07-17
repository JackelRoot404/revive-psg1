# Revive PSG1

Self-service software for converting a compatible PlaySolana PSG1 into a general-purpose Android gaming handheld. The product is a Netlify-hosted Chrome/Edge WebUSB wizard backed by a Fastify API on DigitalOcean App Platform.

> **Early Access / fail-closed installation.** Access is free while the project matures. Compatibility, signing/provenance, restoration, dependency/legal work, and every destructive-installation gate still fail closed. Do not distribute experimental images.

## What is implemented

- Read-only Android Rockchip CPU serial → Fastboot protocol verification, browser USB-descriptor telemetry, and stable SHA-256 device binding.
- Signed firmware-profile matching and unknown-firmware rejection.
- Signed ephemeral web sessions, a free WebUSB ADB/Fastboot identity scan, Wallet Standard checkout, exact 19 USDC construction, finalized verification, purpose-bound receipt-wallet installer authorization, one-use references, and device-bound licensing.
- Backend-approved, one-time beta invites bound to a scanned device and atomically capped at ten redemptions; `BICCSDEV` is an internal program label, not a public coupon.
- Recoverable device entitlement independent of the installed Android OS or computer.
- Journaled allowlisted installer engine for `fastboot oem at-unlock-vboot`, validated fastbootd, vbmeta/system flashing, wipe, and reboot.
- Resume-capable, three-attempt artifact downloads with size and SHA-256 verification.
- Refund cutoff recorded immediately before destructive work, plus pre-modification refund requests.
- Netlify landing page, checkout, docs, privacy, and terms.
- DigitalOcean App Platform, PostgreSQL, Valkey, and Spaces configuration surfaces.

## Product limitations

- The PSG1 remains bootloader-unlocked after conversion.
- The device/ROM is not Google-certified; Play Integrity, banking, DRM, and some games may refuse to run.
- Revive does not distribute, proxy, or host an unlicensed Play-enabled Android image. Every accepted customer-supplied artifact must match an exact signed release hash.
- Fingerprint is currently unvalidated and not guaranteed, so it is not a launch feature.
- echOS restoration depends on a verified official image for the matching PSG1 variant.
- Universal Android application compatibility is not promised.

## Repository

```text
apps/web       Next.js website, WebUSB wizard, and injected-wallet checkout (Netlify)
apps/api       Fastify API, Drizzle schema/migrations, Solana verification (DigitalOcean)
packages/contracts  Shared Zod schemas, messages, constants
profiles       Unsigned compatibility-profile source templates
tools          Offline signing utilities (private keys are never committed)
```

## Local development

Requirements: Node 22+, Docker, and a current Chromium browser with WebUSB.

```bash
npm install
docker compose up -d
npm run db:migrate
npm run db:seed -w @revive-psg1/api
npm run dev:api
npm run dev:web
```

The API intentionally reports devices as unsupported unless `RELEASE_PUBLIC_KEY_PEM` is configured and the database contains a matching active profile whose canonical JSON signature verifies.

### Test without a stock PSG1

The wizard has a deterministic, non-destructive stock-device fixture for local development. Start both services with the flag enabled:

```bash
REVIVE_DEV_HARDWARE_FIXTURE=true npm run dev:api
REVIVE_DEV_HARDWARE_FIXTURE=true npm run dev:web
```

Open `http://localhost:3000/wizard` and choose **Simulate stock PSG1**. The fixture exercises session creation, free entitlement, and release authorization without USB hardware. It uses a fixed fake device ID, returns no artifacts, rejects the destructive installation boundary, and is refused by production configuration. It is a software-flow test only; it cannot replace a real stock-hardware flashing and recovery test.

## Verification

```bash
npm run typecheck
npm test
npm run build
```

CI repeats the Node, Android diagnostics, dependency-audit, and CodeQL checks.

## Production deployment

See the [tester launch checklist](docs/tester-launch-checklist.md), [devnet payment testing](docs/devnet-payment-e2e.md), [deployment](docs/deployment.md), [security](docs/security.md), [browser installer](docs/web-installer.md), [beta runbook](docs/beta-runbook.md), [operations](docs/operations.md), and [release process](docs/release.md). The essential order is:

1. Provision Managed PostgreSQL, Managed Valkey, and a private Spaces bucket.
2. Create separate runtime, migration, and read-only PostgreSQL roles; restrict trusted sources to the App Platform service and require CA-verified TLS.
3. Deploy `apps/api/.do/app.yaml`, apply migrations with the migration role, then run the idempotent seed.
4. Deploy the root repository to Netlify using `netlify.toml` and public-only `NEXT_PUBLIC_*` variables.
5. Upload signed private artifacts to Spaces and insert their separately signed release manifest.
6. Open tester access only after all launch-gate records carry reviewed evidence.

Early Access is free when `EARLY_ACCESS_FREE=true` (the default). This creates a zero-value device-bound entitlement without wallet or payment requirements while preserving the paid checkout implementation. Set the same flag to `false` on the API and web deployment to restore paid enforcement.

The optional-donation treasury is fixed to `EAjkNpwau3hB58C2M4U8rQWFANHRidA8XiB4Dvq78T4y`. No treasury private key is needed or accepted by this system.

## Signing a profile or manifest

Keep the offline Ed25519 private key on an isolated signing machine. The helper writes the signed envelope to stdout and never writes the key:

```bash
REVIVE_OFFLINE_SIGNING_KEY_PEM="$(security find-generic-password -w -s revive-release-key)" \
  node tools/sign-document.mjs profiles/psg1-rk3588s-v11.template.json \
  > psg1-rk3588s-v11-api35-v1.signed.json
```

The checked-in profile is only a source template. Its firmware pattern must be widened only after read-only partition, bootloader, vendor, serial-uniqueness, controls, Wi-Fi, audio, storage, fingerprint, and restoration validation.
