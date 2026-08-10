# Community handoff

## Status on 2026-08-10

Active development and hosted operation have ended. This repository is being
published so the PSG1 community can study and continue the work. It is not a
finished installer and has no funded maintainer or support commitment.

The API defaults to `INSTALLER_MODE=scan_only`. Keep it that way. No stock,
locked PSG1 completed this installer, no system image is approved for release,
and no PSG1-only signed Windows Fastboot driver exists. The project owner did
not have access to a stock unit. An already-unlocked unit is not evidence for
the stock-to-unlocked path.

## What exists

- A Next.js WebUSB scan/installer prototype and Fastify policy API.
- Cross-mode Android CPU serial and Fastboot protocol serial continuity checks.
- Signed profile/release schemas, fixed flash-plan validation, artifact hashing,
  and a server/local write-ahead installation journal.
- A runtime emergency gate, device/release-bound resume design, simulations,
  automated tests, and incomplete Windows-driver documentation.
- Android diagnostics source code.

Browser-reported identity is not trusted hardware attestation. The presence of
an implementation path or a passing fixture does not make destructive flashing
safe.

## Where the Lineage build stopped

The final experiment used the official LineageOS 22.2 / Android 15 source tree,
the `lineage_gsi_arm64-user` target, and no external Andy Yan, Treble overlay,
GApps, root, or insecure-ADB project. The source graph was pinned in
[`lineage-22.2-pinned-manifest.xml`](handoff/lineage-22.2-pinned-manifest.xml).

On an Apple-silicon Mac, the Linux/amd64 Docker build ran through Rosetta. Soong
completed after applying the documented 20 GiB Go memory limit, but the build
was intentionally stopped during `ckati` Make-to-Ninja generation when the
project was handed to the community. No system or target-files output from that
build exists. The local build volume was deleted after publication.

The host-only patch is preserved at
[`0001-soong-bound-primary-builder-memory.patch`](handoff/0001-soong-bound-primary-builder-memory.patch).
It changes Go garbage-collection pressure during graph generation, not Android
target contents.

Two downloaded comparison GSIs were rejected as public release artifacts:

- The July 2026 Odd Solutions image contained GMS/Play packages.
- Andy Yan's June 2025 vanilla image appeared GMS/root-free in inspection but
  was a userdebug/test-key build with insecure ADB and unresolved wrapper-script
  licensing/authenticity. It was never validated on a stock PSG1.

No downloaded GSI, APK, vbmeta image, signed pilot manifest, private key, or
device dump is included in this repository.

## Required gates before any flashing release

1. Capture immutable hardware, partition, AVB/vbmeta, bootloader, Fastbootd, and
   USB interface facts from consenting stock, locked PSG1 units.
2. Establish a trustworthy server-side device-attestation design; browser USB,
   ADB, and Fastboot observations alone are forgeable.
3. Produce a reproducible, license-reviewed, GMS-free release-key build and
   independently inspect every shipped byte and signature.
4. Create a narrowly targeted, signed WinUSB package from real PSG1 `USB
   Download Gadget` hardware IDs. Never target generic Rockchip or ADB devices.
5. Review the signed flash plan against the actual partition layout and recovery
   behavior. Provide an honest irreversibility disclosure and recovery plan.
6. Complete one supervised stock-device pilot, diagnostics, two cold boots, and
   cable/tab/crash/resume fault testing.
7. Test current Chrome and Edge on Windows and macOS, including wrong-device,
   low-power, low-storage, tampered-artifact, interrupted-transfer, and stale
   credential cases.
8. Obtain independent security review before changing the runtime mode away
   from `scan_only`.

## Suggested ownership model

The first community maintainers should document their scope in pull requests,
require two-person review for release/profile/flash-plan changes, keep signing
keys outside Git, and publish reproducible evidence before binaries. A new
maintainer must create new signing keys; the original project keys were
destroyed at handoff.

The project is unofficial and unaffiliated with PlaySolana, Solana Mobile,
Google, or LineageOS.
