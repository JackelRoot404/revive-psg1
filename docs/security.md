# Security model

## Trust boundaries

- The browser can collect USB/ADB/Fastboot observations and request an activation, but it cannot issue an entitlement, choose a release, or substitute a flash command. Its observations are untrusted input, not hardware attestation.
- The API evaluates that input against signed profiles and releases, issues online authorization, and binds an installation to an exact release. It cannot itself observe a PSG1, sign firmware/releases, or turn browser observations into a trusted claim about physical hardware.
- The browser cannot run the destructive engine through the supported flow without an API-recorded boundary, device-matching installer token, signed profile/manifest, exact artifact hashes, fixed flash plan, and exact wipe phrase.
- Release, AVB, desktop-code-signing, and updater private keys are separate and offline or held by the relevant signing service.

The service is deliberately **scan-only** today. Do not treat the implementation
of the public route as authorization to enable it: it still needs a trusted
hardware-attestation source, actual signed release materials, a signed PSG1-only
Windows driver, and completed physical-host validation. A static build, a
signed JSON template, or `INSTALLER_MODE=public` cannot supply any of those.

## Device identity

The browser uses `SHA-256("revive-psg1:v1" || normalized_fastboot_serial)` as the
stable binding key. PSG1 exposes different ordinary USB/ADB descriptor serials
across Android and Fastboot modes, so those mode-specific values are never used
as the entitlement key. Before forming the key, the wizard reads the immutable
Rockchip CPU `Serial` through ADB and requires it to equal the Fastboot protocol
serial. The browser-reported Fastboot USB descriptor is compared and recorded,
but Brave may return a cached Android-mode value for an already-paired device;
a descriptor mismatch is therefore advisory only after the CPU-to-protocol
match succeeds. Native diagnostics can independently record the operating-
system Fastboot descriptor. Only the resulting domain-separated hash leaves the
computer. Android installation IDs, mode-specific USB identifiers, host IDs,
fingerprints, hostnames, and wallets are never entitlement keys.

The device hash is an identifier, not an authenticator. A custom client can
fabricate browser-side USB/ADB/Fastboot observations, including a serial match.
The signed pairing proof proves possession of a browser-generated key; it does
not prove that the key is attached to a real stock PSG1. A read-only scan never
grants destructive authorization. Before any public destructive route can open,
an independently trusted source (for example, a signed boot-chain/TEE assertion,
an OEM service, or an audited companion with an equivalent trust boundary) must
validate the immutable identity and stock/locked state. That source is not
implemented here, so the runtime mode remains `scan_only`.

## Destructive boundary and resume

Immediately before the first Fastboot operation, the owner must accept the
versioned no-recovery warning and type the exact wipe phrase. The API binds that
boundary to the exact signed profile, release version, and artifact-hash map.
The browser performs a fresh Android preflight immediately before requesting
that boundary: it rechecks the CPU serial, locked stock state, USB stability,
power, identity/build markers, and signed system/super-partition capacity. The
Fastbootd path rechecks capacity before resize or system flash. The browser
writes `intent`, `sent`, and `verified` records locally and to an append-only
server journal before/after each signed operation.

For an ordinary interruption, a new cross-mode scan must prove the same device.
If a tab crash leaves an already-bound device in Fastboot/Fastbootd, the wizard
also keeps an expiring opaque resume credential in its same-origin persistent
journal. The credential rotates on use and can retrieve only the existing
device's exact active signed binding and journal checkpoint; it cannot activate,
rebind, or start a different installation. The selected Fastboot protocol serial
is checked against the stored binding before that request. This remains a
browser-side continuity check, not independent hardware attestation. An
emergency `INSTALLER_NEW_STARTS_ENABLED=false` pause blocks new boundaries while
retaining this exact-resume path. An arbitrary already-modified or unlocked PSG1
remains read-only.

## Logs and reports

Fastify redacts authorization, signatures, pairing proofs, and raw compatibility reports. Audit actors are domain-separated hashes. Crash stacks remove base58-like secrets and 64-character hashes. Compatibility reports use an opt-in approved schema and must not include raw serials, USB IDs, or unrestricted ADB logs. Operational monitoring uses only redacted aggregate scan outcomes, driver failures, activation/start/resume/completion counts, and error codes.

## Known pre-release requirements

- Design, implement, and independently assess trusted PSG1 hardware attestation before enabling any public destructive route. The browser session and cross-mode serial check do not meet this requirement.
- Produce the actual GMS-free system, production AVB/vbmeta material, diagnostics/APKs, hashes, licensing/no-GMS review, provenance, and offline signatures. Placeholder artifacts and templates are never release evidence.
- Capture PSG1 Fastboot hardware IDs, create a narrowly targeted WinUSB INF, obtain the required Windows signatures, and complete clean-host Chrome/Edge testing. No generic Rockchip, Zadig, or Android ADB driver may be represented as the first-party package.
- Complete physical stock-device runs for the captured stock-build vectors (including 1.1.23) in Chrome and Edge on Windows and macOS, with disconnect, crash, wrong-device, and Fastbootd-resume fault coverage. Browser reboot telemetry is not evidence of a physical cold boot.
- Keep high/critical dependency findings at zero and review the lockfile before each release. The legacy Solana/wallet-adapter dependency chain has been removed. As of the current lockfile, `npm audit` reports no high/critical findings; its remaining moderate findings are the latest stable Next.js package's pinned PostCSS and API-only Drizzle/esbuild development tooling. Track upstream fixes instead of forcing incompatible dependency downgrades.
- Add an authenticated operator surface or audited SQL runbook for redacted operational aggregates and launch evidence.
- Pen-test pairing/replay, signed-JSON canonicalization, presigned URL leakage, resume-journal tampering, Fastboot disconnects, and stale-token recovery.
- Do not advertise an echOS restoration path unless official, legally distributable restoration materials and a physically validated recovery runbook exist. The proposed public flow must disclose that no stock restore image is currently provided.
- Resolve Google Play/GMS redistribution and trademark rights before including those binaries or claims in any release. The public universal release is GMS-free.
- Pin every GitHub Action to a reviewed full commit SHA and configure branch/environment protection before credentialed release automation is added.
- Commission legal review for terms, privacy retention, support identity, jurisdiction, warranty, tax, and refund handling.
