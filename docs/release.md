# Release process

1. Collect unknown-build reports without charging or modifying devices.
2. Validate partitions, sizes, bootloader commands, vendor compatibility, controls, Wi-Fi, audio, storage, fingerprint HAL, and echOS restoration.
3. Update the profile source and sign its canonical JSON offline.
4. Build Android/vbmeta artifacts from recorded, reproducible inputs; AVB-sign with the separate offline key.
5. Hash every final byte, upload to private Spaces, and create/sign the release manifest offline.
6. Run automated interruption, range-resume, tamper, replay, eleventh-promo, USB disconnect, unsupported firmware, and Fastboot failure tests.
7. Perform two cold boots plus the hardware/app test suite on the target profile.
8. Build the desktop with embedded release/license public keys; sign and notarize on isolated CI runners.
9. Publish the manifest and desktop release. Keep paid checkout disabled until all launch gates pass.

## No-credential readiness workflow

`.github/workflows/release-readiness.yml` accepts only a full reviewed commit SHA and exact semver. It repeats builds/tests and blocks on high/critical dependency findings. It intentionally does not sign, upload, publish, or enable sales. Configure the GitHub `release` environment with required reviewers before adding credentialed signing jobs.

The signing handoff must keep four trust domains separate: Android AVB, offline profile/release manifests, Apple/Windows desktop identity, and Tauri updater. Never expose AVB or offline release keys to the API, Netlify, or ordinary CI runners.

## Release evidence bundle

Archive canonical signed profile/manifest JSON; SHA-256 and byte size for every artifact; reproducible input/toolchain identifiers; AVB metadata; Apple notarization result; Windows signature/timestamp verification; updater signature; dependency/SBOM reports; beta/adversarial evidence; restore-test record; reviewers; and exact source commit. Sign the evidence index and store it separately from mutable operational logs.

## Required launch evidence

- Exactly ten beta license redemptions.
- Five successful Windows and five successful macOS installations.
- Signed profiles for all beta-observed production variants.
- No unrecovered beta device.
- Serial uniqueness across the cohort.
- End-to-end official echOS restoration.
- Passing adversarial suite, including replay, eleventh redemption, manifest tamper, interruption, disconnect, unsupported firmware, and Fastboot failures.

The API requires these as passed `launch_gate_checks` records in addition to `PUBLIC_SALES_ENABLED=true`.

## Additional blockers

- The same-computer tests in `checkout-pairing.md` must pass on signed macOS and Windows packages before the web source gate is enabled.
- High/critical JavaScript findings must remain at zero. Review and record the remaining moderate upstream Next/PostCSS and API development-tool findings before release; do not force an incompatible downgrade to silence the audit.
- Revive must not distribute, proxy, or host the Play-enabled LineageOS system image. Google states that GMS is outside AOSP and license-only: [official GMS overview](https://www.android.com/gms/). The customer-supplied flow accepts only the exact signed system archive selected locally from its original publisher, verifies archive and expanded-image size/hash, and never uploads it.
- Fingerprint is unvalidated and not guaranteed; it cannot be advertised as supported.
- Official echOS restoration must pass for every supported profile.
- Counsel must approve final terms, privacy, warranty, refund, tax, support, and jurisdiction text.
- Pin workflow actions to reviewed commit SHAs before any signing credential or publish permission is introduced.
