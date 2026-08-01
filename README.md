# Revive PSG1

Self-service software for converting a compatible, stock PlaySolana PSG1 into a general-purpose Android gaming handheld. The product is a Netlify-hosted Chrome/Edge WebUSB wizard backed by a Fastify API on DigitalOcean App Platform.

> **Current availability: read-only scan only.** The repository defaults the API to `INSTALLER_MODE=scan_only`; the public installer must remain closed. The code has public-flow safeguards, but this repository does not yet contain a production release, a signed PSG1-only Windows driver, completed physical-host testing, or a trusted hardware-attestation source. A browser scan alone cannot prove that a caller owns a particular physical PSG1. Do not set `INSTALLER_MODE=public` or distribute experimental images.

## What is implemented in the codebase

- Read-only Android Rockchip CPU serial → Fastboot protocol verification, browser USB-descriptor telemetry, and a stable SHA-256 device-binding key.
- Signed universal-stock-profile matching, granular read-only preflight decisions, and consented/redacted unknown-hardware/build reporting.
- Signed ephemeral web sessions plus code paths for free public activation, atomic first-device binding, and a device-bound installation entitlement. Those paths are runtime-gated and are not currently available to customers.
- The API selects only a signed release explicitly bound to the scanned signed profile.
- Browser Fastboot transport supports the guarded download protocol, local and server-backed write-ahead journaling, a same-origin durable Fastboot-only resume credential, and fails closed until the exact signed artifact and hardware download-window are validated.
- Journaled allowlisted installer engine for `fastboot oem at-unlock-vboot`, validated fastbootd, vbmeta/system flashing, wipe, and reboot.
- Resume-capable, three-attempt artifact downloads with size and SHA-256 verification; signed minimum system/super-partition capacity is checked before resize and flash.
- Versioned irreversible-risk acknowledgement recorded immediately before destructive work.
- A signed-release-bound Windows Fastboot-driver metadata path. This is not a shipped driver package; no generic Rockchip or ADB driver may be substituted.
- Netlify landing page, public installer wizard, docs, privacy, and terms.
- DigitalOcean App Platform, PostgreSQL, Valkey, and Spaces configuration surfaces.

## Product limitations

- This is not a public flashing service today. `scan_only` results are compatibility observations, not an approval to unlock or flash.
- A WebUSB/ADB/Fastboot client can report fabricated device observations. The current cross-mode serial match is a useful continuity check and a device-binding input, but it is not trusted hardware attestation. A public release requires an independently trusted PSG1 attestation design in addition to the browser flow.
- The PSG1 remains bootloader-unlocked after conversion, and no echOS restoration image is provided. Conversion may be irreversible.
- The device/ROM is not Google-certified; Play Integrity, banking, DRM, and some games may refuse to run.
- Revive mirrors a reviewed, signed-manifest GMS-free system image and verified convenience APKs; it does not distribute Google Mobile Services or Play Store.
- Fingerprint is currently unvalidated and not guaranteed, so it is not a launch feature.
- Universal Android application compatibility is not promised.

## Repository

```text
apps/web       Next.js website and Chrome/Edge WebUSB installer (Netlify)
apps/api       Fastify API, Drizzle schema/migrations, signed release policy (DigitalOcean)
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

The API intentionally reports a non-installable scan decision unless `RELEASE_PUBLIC_KEY_PEM` is configured and the database contains a matching active profile whose canonical JSON signature verifies. Even with those development materials present, keep the service in `scan_only`; a signed profile or manifest is not physical-device attestation.

### Test without a stock PSG1

The wizard has a deterministic, non-destructive stock-device fixture for local development. Start both services with the flag enabled:

```bash
REVIVE_DEV_HARDWARE_FIXTURE=true npm run dev:api
REVIVE_DEV_HARDWARE_FIXTURE=true npm run dev:web
```

Open `http://localhost:3000/wizard` and choose **Simulate stock PSG1**. The fixture exercises session creation, free entitlement, and release authorization without USB hardware. It uses a fixed fake device ID, returns no artifacts, rejects the destructive installation boundary, and is refused by production configuration. It is a software-flow test only; it cannot replace real stock-hardware flashing validation.

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
6. Keep `INSTALLER_MODE=scan_only` until the trusted hardware-attestation design, real signed public-release materials, signed PSG1-only Windows driver, and physical Windows/macOS browser validation are independently reviewed. A template, a browser-only scan, or a configuration flag is not sufficient to switch to `public`.

The browser installer remains read-only while the API is `scan_only`. `INSTALLER_MODE` is a runtime API switch, so Netlify does not carry a separate destructive-installation feature flag. It is a gate, not evidence that the required release or trusted hardware-attestation work has occurred. Public sales remain disabled; any future eligible public installation is intended to be free and device-bound.

## Signing a profile or manifest

Keep the offline Ed25519 private key on an isolated signing machine. The helper writes the signed envelope to stdout and never writes the key:

```bash
REVIVE_OFFLINE_SIGNING_KEY_PEM="$(security find-generic-password -w -s revive-release-key)" \
  node tools/sign-document.mjs profiles/psg1-rk3588s-v11.template.json \
  > psg1-rk3588s-v11-api35-v1.signed.json
```

The checked-in profile is only a source template. A universal stock PSG1 profile must verify immutable hardware identity, a locked stock PlaySolana build marker, partition layout, Fastboot protocol capability, battery, and host capacity; it is not a generic Rockchip profile. Browser-collected values still need to be backed by a trusted attestation source before public destructive authorization. Add a higher-priority split profile only after variant-specific partition, bootloader, vendor, controls, Wi-Fi, audio, storage, and fingerprint validation.

Insert or refresh a signed profile in PostgreSQL with:

```bash
DATABASE_URL='postgresql://revive:revive@localhost:5432/revive_psg1' \
  node tools/insert-compatibility-profile.mjs ~/revive-signing/psg1-rk3588s-v11-api35-v1.signed.json
```

Production cutover steps: [compatibility-checker-cutover.md](docs/compatibility-checker-cutover.md).
