# Universal public PSG1 release checklist

This checklist describes the materials that must exist before the runtime
`INSTALLER_MODE=public` switch is enabled. It intentionally cannot be satisfied
by template JSON, browser-only device observations, or a feature flag. The
current service must remain `scan_only` until every item is complete and
independently reviewed.

1. Establish an independently trusted PSG1 hardware-attestation source that
   validates the immutable device identity and stock/locked state. A WebUSB
   scan, CPU-to-Fastboot serial match, browser pairing proof, or device hash is
   not an authenticator; a custom client can fabricate those observations. Use
   a signed boot-chain/TEE assertion, OEM service, or an audited companion with
   an equivalent trust boundary. This requirement is not implemented by the
   browser wizard.
2. Build the reviewed GMS-free ARM64 system image from a reproducible input and
   retain the source URL/tag/toolchain information.
3. Produce a matching production AVB-signed `vbmeta` image with the offline AVB
   key. Record the AVB metadata and tie it to the exact system-image hash.
4. Build/sign the diagnostics APK and test APK; record reviewed Aurora Store and
   RetroArch artifacts.
5. Run source-license and no-GMS inspections, hash every final byte, then build
   and offline-sign the release manifest and universal stock PSG1 profile. The
   manifest must contain the fixed allowlisted flash plan, exact artifact roles,
   signed minimum system/super-partition capacities, provenance, and offline
   signatures. Placeholder artifacts, hashes, or evidence cannot be deployed.
6. Capture stock build vectors—including 1.1.23—and validate that each passing
   stock, locked unit matches the universal profile by immutable hardware,
   PlaySolana stock markers, partition/capability probes, and Fastboot protocol,
   not by a firmware-version allowlist. Resolve any equal-priority profile match
   as an error; use a higher-priority signed variant profile only after complete
   hardware validation.
7. Upload only the signed private artifacts to object storage. Insert the
   signed profile and matching release manifest into production.
8. Capture real PSG1 Fastboot hardware IDs and interface data, create the
   narrowly targeted WinUSB INF for **USB Download Gadget**, obtain the required
   Windows catalog/installer signatures, and publish its hashes and signer only
   in the signed release evidence. It must not match generic Rockchip hardware
   or the Android ADB Interface.
9. Test the production API in `scan_only` mode. It must return accurate scan
   decisions while denying activation and all destructive routes, including new
   starts and artifact downloads.
10. Complete stock-device runs in Chrome and Edge on both Windows and macOS,
    including low battery/storage, cable disconnect, tab crash, stale token,
    wrong-device selection, Fastbootd mismatch, sparse-transfer interruption,
    exact signed resume, and artifact-tampering cases. The release evidence must
    record each browser result, controls, Wi-Fi, audio, storage, Aurora Store,
    RetroArch, diagnostics, and real physical cold-boot tests as passed. Two
    browser-initiated reboot cycles do not by themselves prove cold boots.
11. Obtain a final independent review of the attestation design, release
    evidence, driver package, and physical test results. Only then set the API
    runtime mode to `public`. It is the only change that enables new
   free installations; the web bundle does not contain an independent unlock
   switch.

If a device has already crossed the destructive boundary, an emergency switch
may block new starts but must continue to authorize that same device's exact
signed release for recovery/resume. Use
`INSTALLER_NEW_STARTS_ENABLED=false` for that narrow pause; the API journal
records `intent`, `sent`, and `verified` checkpoints for the exact device,
profile, release, and artifact hashes. A stranded Fastboot/Fastbootd device can
resume only with the browser's rotating, expiring same-origin credential and
the exact existing binding; it cannot activate a different device or release.
