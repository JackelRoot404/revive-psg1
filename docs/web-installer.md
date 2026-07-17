# Browser installer architecture

Revive PSG1 is delivered through a browser-based WebUSB wizard.

## Supported environment

- Current desktop Chrome or Edge on macOS or Windows.
- A secure HTTPS origin with WebUSB enabled by `Permissions-Policy`.
- A data-capable USB cable and a PSG1 that exposes a stable manufacturer serial.
- An injected Solana Wallet Standard extension. Phantom and Solflare are explicit test targets; the implementation is capability-based rather than name-allowlisted.

Safari, Firefox, Android, and iOS are unsupported because they do not provide the required WebUSB path. On Windows, every PSG1 reboot mode must already use a WebUSB-compatible WinUSB driver. A website cannot install or rebind a kernel driver.

## Gated flow

1. The browser requests the PSG1 ADB interface and reads only compatibility properties.
2. It reboots to Fastboot, requests that USB interface, cross-checks the ADB, Fastboot, and USB serials, reads the system partition size, and reboots to Android.
3. The browser creates a signed ephemeral session. The private session key is kept in memory.
4. Unknown firmware stops before charging, binding, unlocking, wiping, or flashing.
5. A compatible injected wallet signs a checkout challenge. Paid orders transfer exactly 19 USDC and are accepted only after finalized backend verification.
6. The receipt wallet signs a second message bound to the web-installer purpose, order, license, device, nonce, and expiration.
7. The API issues a ten-minute `web-installer` token. The token can fetch the signed release and mark the destructive boundary; it cannot claim, recover, or refund a license.
8. Every release profile, manifest, and artifact must pass signature and hash verification before any destructive command.

During free Early Access, steps 5 and 6 are replaced by a zero-value device-bound activation. The wallet/payment implementation remains disabled behind `EARLY_ACCESS_FREE=true` rather than being removed.

The free scan intentionally precedes payment: compatibility and the stable device identifier must be known before a customer can be charged.

## Current safety gate

The checked-in browser alpha implements the read-only ADB/Fastboot scan and payer-gated release authorization. Destructive WebUSB flashing remains disabled until all of these are recorded on the same test PSG1 from both macOS and Windows:

- Stock/installed Android ADB
- Recovery ADB
- Bootloader Fastboot
- Userspace Fastbootd
- USB VID/PID, interface class/subclass/protocol, endpoint directions, serial visibility, and Windows driver binding for every mode

The destructive implementation must additionally support `max-download-size`, Android sparse images, resumable downloads, local SHA-256 verification, interruption-safe journaling, explicit wipe confirmation, and tested recovery paths.

### Safe testing lanes

- `already_modified`: the actual system fingerprint and Lineage marker show that the PSG1 is already running a modified OS. Detection, device binding, entitlement, and diagnostics may be tested, but the API rejects `installation-started` for that session.
- `development_fixture`: enabled only when both local services run in development with `REVIVE_DEV_HARDWARE_FIXTURE=true`. The exact deterministic fixture simulates a stock, locked PSG1 and completes the web/API state machine with no USB access, no artifacts, and no destructive permission. Production startup fails if this flag is enabled.

Neither lane counts as validation of stock bootloader unlock, flashing, failure recovery, or echOS restoration. Those gates still require a real stock unit or a verified customer-assisted beta session.

## Browser supply-chain controls

Installer pages use no third-party runtime scripts, are not framed, are not indexed, and are served with no-store caching. Deployment must use locked dependencies, reviewed build provenance, strict CSP, signed compatibility profiles and manifests, offline release/AVB keys, a separate online license key, and short-lived private artifact URLs.

## Primary references

- [WebUSB specification](https://wicg.github.io/webusb/)
- [Chrome WebUSB overview](https://developer.chrome.com/docs/capabilities/usb)
- [Chrome WebUSB device and Windows driver guidance](https://developer.chrome.com/docs/capabilities/build-for-webusb)
- [AOSP Fastboot protocol](https://android.googlesource.com/platform/system/core/+/refs/tags/android-cts-7.0_r33/fastboot/fastboot_protocol.txt)
- [AOSP ADB protocol](https://android.googlesource.com/platform/system/core/+/android10-release/adb/protocol.txt)
- [Phantom Wallet Standard](https://docs.phantom.com/developer-powertools/wallet-standard)
- [Solflare sign-message method](https://docs.solflare.com/solflare/technical/deeplinks/provider-methods/signmessage)
