# Release process

1. Collect unknown-build reports without charging or modifying devices.
2. Validate partitions, sizes, bootloader commands, vendor compatibility, controls, Wi-Fi, audio, storage, and fingerprint HAL.
3. Update the profile source and sign its canonical JSON offline.
4. Build Android/vbmeta artifacts from recorded, reproducible inputs; AVB-sign with the separate offline key.
5. Hash every final byte, upload to private Spaces, and create/sign the release manifest offline.
6. Run automated interruption, range-resume, tamper, replay, eleventh-promo, USB disconnect, unsupported firmware, and Fastboot failure tests.
7. Perform two cold boots plus the hardware/app test suite on the target profile.
8. Build the signed PSG1-specific Windows Fastboot WinUSB package and verify the macOS browser path.
9. Publish the manifest, private artifact objects, and driver package while `INSTALLER_MODE=scan_only`; then switch the API to `public` for free self-service.

## No-credential readiness workflow

`.github/workflows/release-readiness.yml` accepts only a full reviewed commit SHA and exact semver. It repeats builds/tests and blocks on high/critical dependency findings. It intentionally does not sign, upload, publish, or enable sales. Configure the GitHub `release` environment with required reviewers before adding credentialed signing jobs.

The signing handoff must keep four trust domains separate: Android AVB, offline profile/release manifests, Apple/Windows desktop identity, and Tauri updater. Never expose AVB or offline release keys to the API, Netlify, or ordinary CI runners.

## Release evidence bundle

Archive canonical signed profile/manifest JSON; SHA-256 and byte size for every artifact; reproducible input/toolchain identifiers; AVB metadata; dependency/SBOM reports; public-release/adversarial evidence; irreversible-risk acknowledgement evidence; reviewers; and exact source commit. Sign the evidence index and store it separately from mutable operational logs.

## Required launch evidence

- A signed universal stock PSG1 profile and release manifest whose profile IDs agree.
- Exact hashes, signed flash plan, provenance, license review, no-GMS review, and public-risk approval for every private artifact.
- Signed PSG1-specific Windows Fastboot driver evidence plus completed Chrome
  and Edge browser-flow evidence on Windows and macOS. A public manifest is
  rejected unless its signed evidence records all four host/browser results
  and the stock-device hardware test set as passed.
- Passing adversarial suite, including replay, manifest tamper, interruption, disconnect, unsupported firmware, and Fastboot failures.

The API verifies the signed profile, release, artifact, and public-evidence requirements before it allows a public installation start.

## Additional blockers

- The Windows and macOS WebUSB Fastboot tests must pass before the API is set to public mode.
- High/critical findings in the API runtime must remain at zero. Record and review unavoidable static-site build-tool advisories; do not force an incompatible downgrade to silence an audit.
- Revive must not distribute or host a Play-enabled LineageOS system image. Google states that GMS is outside AOSP and license-only: [official GMS overview](https://www.android.com/gms/). Mirror only the exact reviewed GMS-free image recorded by the signed release manifest.
- Fingerprint is unvalidated and not guaranteed; it cannot be advertised as supported.
- Counsel must approve final terms, privacy, warranty, refund, tax, support, and jurisdiction text.
- Pin workflow actions to reviewed commit SHAs before any signing credential or publish permission is introduced.
