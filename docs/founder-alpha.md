# Founder alpha on one PSG1

This phase validates the desktop hosts and service plumbing without pretending that one already-modified PSG1 is a public-release cohort.

## What this device can validate now

- The same hashed PSG1 identity is derived on macOS and Windows from the immutable Rockchip CPU serial read through Android/recovery and verified against the Fastboot protocol; native diagnostics also record the operating-system Fastboot USB descriptor independently of browser caching.
- A signed compatibility profile is accepted and a tampered or unknown profile is rejected.
- Browser checkout pairing cannot be reused from another browser instance or computer.
- A device-bound beta entitlement can be claimed on one host and recovered on the other with the owner-saved recovery credential.
- Downloads resume after interruption and fail closed on a wrong size, hash, or signature.
- Aurora Store, F-Droid, RetroArch, controls, Wi-Fi, audio, storage, and two cold boots can be recorded by diagnostics.
- A USB disconnect before destructive work resumes safely from the journal.

## What it cannot validate

- Serial uniqueness across production PSG1 units.
- Other board, bootloader, partition-layout, or stock-firmware variants.
- A clean stock-echOS-to-Android conversion, because the founder device is already converted.
- Official echOS restoration, because no customer-supplied, verified restore package currently exists.
- Recovery behavior for a second physical PSG1.

These limitations keep paid public sales and automated destructive installation closed.

## macOS pass

1. Build and run the desktop application locally with sales closed.
2. Connect the powered-on PSG1 with a known-good data cable and authorize ADB.
3. Save only the redacted scan and confirm the application never logs the raw serial.
4. Reboot through Android, recovery, and Fastboot one at a time and confirm the derived device hash remains identical.
5. Redeem one founder beta invite, save the shown-once recovery credential outside the application, and verify the signed license.
6. Interrupt an artifact download and verify range-resume, retry limits, final size, SHA-256, and signature checks.
7. Run non-destructive diagnostics and record the host version, application commit, profile ID, and pass/fail evidence.

## Windows pass

1. Use a clean Windows user profile and a fresh build from the same source commit.
2. Repeat the identity checks and confirm the device hash matches the macOS result exactly.
3. Confirm an entitlement lookup alone does not issue a license.
4. Enter the owner-saved recovery credential and verify the existing device entitlement is restored without the original wallet.
5. Repeat interrupted-download and tamper tests.
6. Run diagnostics and attach only redacted evidence to the alpha record.

## Distribution during founder alpha

Unsigned or locally signed builds are for the founder's own computers only. Do not publish them as general downloads. A public macOS download needs Developer ID signing and notarization for a normal Gatekeeper experience; a public Windows download should use a publicly trusted Authenticode signing option for publisher identity and SmartScreen reputation.

The Apple App Store and Microsoft Store are not required. The website can host links to signed installers after their signatures, hashes, provenance, and update manifests have passed release review.

## Exit criteria

- Both host passes use the same source commit and produce matching device hashes.
- No raw serial, wallet secret, Google credential, PIN, recovery credential, or signing key appears in logs or evidence.
- Pairing replay, license replay, wrong-device recovery, artifact tampering, and interrupted downloads fail safely.
- The founder device completes two cold boots and the expected hardware/app diagnostics.
- Every failure and manual workaround is converted into a tracked issue before recruiting external testers.

After this alpha, recruit separate PSG1 owners to cover five Windows and five macOS installations, known firmware variants, serial uniqueness, and recovery. Do not count repeated runs on the founder device as ten independent beta devices.
