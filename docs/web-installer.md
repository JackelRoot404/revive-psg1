# Browser installer architecture

Revive PSG1 is delivered through a browser-based WebUSB wizard.

> **Current operating state:** the API is intentionally `scan_only`. This
> document describes the guarded public-installer design and the work that must
> be completed before it can be enabled; it does not mean that a PSG1 can be
> flashed today.

Browser-collected USB, ADB, and Fastboot information is not trusted hardware
attestation. A CPU-serial-to-Fastboot-protocol-serial match is an important
continuity check, but a custom client can fabricate browser observations. Public
destructive authorization needs an independent trusted PSG1 attestation source
as well as the signed-release and physical-validation work described below.

## Supported environment

- Current desktop Chrome or Edge on macOS or Windows are the intended first
  public hosts, pending completed physical-host validation.
- A secure HTTPS origin with WebUSB enabled by `Permissions-Policy`.
- A data-capable USB cable and a PSG1 whose immutable Rockchip CPU serial is readable through Android and agrees with Fastboot.

Safari, Firefox, Android, and iOS are unsupported because they do not provide the required WebUSB path. On Windows, every PSG1 reboot mode must already use a WebUSB-compatible WinUSB driver. A website cannot install or rebind a kernel driver.

## Windows Fastboot driver

The intended production Windows path uses a signed, PSG1-specific WinUSB
package. It must be limited to the exact Fastboot hardware ID and interface
recorded for **USB Download Gadget**; it must never target a generic Rockchip
VID or the Android ADB Interface. In public mode, the wizard is designed to
retrieve the package metadata only from a signature-verified release envelope
when it detects that Windows cannot open the Fastboot interface. It verifies the
package URL, installer/catalog hashes, Authenticode signer, exact hardware IDs,
and interface GUID from that signed record.

The package source and release checklist live in
[`docs/windows-driver/`](windows-driver/). A real INF, catalog, signed
installer, captured PSG1 hardware IDs, clean-host validation, and SHA-256
release record are required before public distribution. No such production
package is included in this repository. Do not publish the template or
substitute a broad third-party driver, Zadig, or an Android ADB driver.

## Designed public installer flow (not enabled)

1. The browser requests the PSG1 ADB interface and reads only compatibility properties.
2. It reads the immutable Rockchip CPU serial through ADB, reboots to Fastboot, and pauses. The owner presses a dedicated continuation button because WebUSB requires a fresh user gesture for the second device chooser. The wizard then requests the Fastboot interface, requires the CPU serial to match the Fastboot protocol, records whether the browser-reported USB descriptor also matches, reads the system partition size, and reboots to Android. Brave can expose a cached Android-mode descriptor for paired devices, so that descriptor flag is advisory only after the immutable identity match succeeds.
3. The browser creates a signed ephemeral session. The private session key is kept in memory.
4. Unknown hardware/builds stop before charging, binding, unlocking, wiping, or flashing; an owner may opt in to a redacted compatibility report.
5. If the API is deliberately switched to `public` only after all release and attestation gates are met, a passing stock-locked device can receive a free device-bound activation without a Discord code, wallet, payment, or per-user approval.
6. The API issues a short-lived `web-installer` token bound to the scanned device and browser session. The destructive boundary stores the exact signed profile, release version, and artifact hashes.
7. Every release profile, manifest, fixed `flashPlan`, system/vbmeta artifact, Aurora Store APK, and RetroArch APK must pass signature and hash verification before any destructive command.
8. Immediately before unlock, the browser reselects Android and repeats the stock/locked identity, USB stability, power, build-marker, and signed system/super-capacity preflight. The owner then accepts the versioned no-recovery warning and types the exact wipe phrase. The browser writes `intent`, `sent`, and `verified` states both locally and to the server before/after each signed operation.

The public installer has no wallet, payment, refund, Discord-code, or echOS recovery flow. Conversion can be irreversible.

## Installer safety gates

The installer accepts only a signed release whose profile matches the scanned
PSG1. Its signed release evidence must record the exact source, artifact hashes,
AVB metadata, no-GMS review, and platform validation before it is distributed.
No configuration flag bypasses those artifact or identity checks.

Those gates are necessary but not sufficient for a public release. They verify
the policy, release, and browser flow; they do not make browser-reported device
state trustworthy. Until independent PSG1 hardware attestation and the real
release/driver validation exist, the API must remain `scan_only`.

- Stock/installed Android ADB
- Recovery ADB
- Bootloader Fastboot
- Userspace Fastbootd
- USB VID/PID, interface class/subclass/protocol, endpoint directions, serial visibility, and Windows driver binding for every mode

The destructive implementation additionally supports `max-download-size`,
Android sparse images, resumable downloads, local SHA-256 verification,
server-backed and local write-ahead interruption-safe journaling, explicit
wipe confirmation, reconnect prompts after every reboot, signed
system/super-partition capacity checks before Fastbootd resize/flash, and
exact-release resume checks. After the destructive boundary, an expiring opaque
credential saved in the same-origin persistent journal can recover an exact
installation that is stranded in Fastboot/Fastbootd; it rotates on use and
cannot create a new entitlement or change the signed release.

### Safe testing lanes

- `already_modified`: the actual system fingerprint and Lineage marker show that the PSG1 is already running a modified OS. The public installer remains read-only. The only exception is an exact server-recorded checkpoint for that same device after it already crossed this installer’s destructive boundary.
- `development_fixture`: enabled only when both local services run in development with `REVIVE_DEV_HARDWARE_FIXTURE=true`. The exact deterministic fixture simulates a stock, locked PSG1 and completes the web/API state machine with no USB access, no artifacts, and no destructive permission. Production startup fails if this flag is enabled.

Neither lane counts as validation of stock bootloader unlock, flashing, failure recovery, or echOS restoration. Those gates still require real stock-unit verification with the signed public release materials.

## Browser supply-chain controls

Installer pages use no third-party runtime scripts, are not framed, are not indexed, and are served with no-store caching. Deployment must use locked dependencies, reviewed build provenance, strict CSP, signed compatibility profiles and manifests, offline release/AVB keys, a separate online license key, and short-lived private artifact URLs.

## Primary references

- [WebUSB specification](https://wicg.github.io/webusb/)
- [Chrome WebUSB overview](https://developer.chrome.com/docs/capabilities/usb)
- [Chrome WebUSB device and Windows driver guidance](https://developer.chrome.com/docs/capabilities/build-for-webusb)
- [AOSP Fastboot protocol](https://android.googlesource.com/platform/system/core/+/refs/tags/android-cts-7.0_r33/fastboot/fastboot_protocol.txt)
- [AOSP ADB protocol](https://android.googlesource.com/platform/system/core/+/android10-release/adb/protocol.txt)
