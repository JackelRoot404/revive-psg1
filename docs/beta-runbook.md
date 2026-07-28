# Private beta runbook

## Entry criteria

- Counsel-approved beta terms, privacy notice, support identity, and incident contact exist.
- The tested profile, release manifest, GMS-free system/vbmeta artifacts, Aurora Store APK, RetroArch APK, and browser installer have independent signatures and recorded hashes.
- The mirrored LineageOS GSI has a recorded upstream release URL/tag, digest, license review, no-GMS inspection, and stock-PSG1 validation.
- **No echOS restoration path is provided.** The beta terms state that conversion may be irreversible; stop on any device in an unknown state.
- Payment remains disabled. Issue one-time Discord `rpb_…` codes with the generator; a code binds atomically to the first supported PSG1 that redeems it. The cohort cap is 25.

## Enroll one device

1. Record a participant ID, host OS, PSG1 stock build, and consent to submit the redacted report. Never copy the raw serial into the tracking sheet.
2. Have the participant open the direct browser wizard in Chrome or Edge on macOS or Windows, then keep their Discord ticket open for live support.
3. Run the read-only scan. Stop on unknown firmware, serial mismatch, low battery, insufficient browser storage, unstable USB, or an already-modified device.
4. Issue `npm run db:beta-invite -w @revive-psg1/api` with production secrets. Optionally set `BETA_INVITE_EXPIRES_AT` and `BETA_INVITE_LABEL`. Deliver the shown-once `rpb_…` code privately; never store it in tickets or logs.
5. Redeem the code only after a supported stock scan. Confirm it binds to that PSG1 once and the global count increased by exactly one; a copied or expired code, duplicate device, or twenty-sixth redemption must fail.
6. Capture the beta-terms/no-recovery acknowledgement and `ERASE PSG1` confirmation. Never request the participant's PIN, wallet seed phrase, Google password, raw serial, or raw ADB log.
7. Run installation and two cold boots. Record pass/fail for controls, Wi-Fi, audio, storage, Aurora Store, RetroArch, diagnostics, and package certificate verification. Fingerprint is recorded as unvalidated/not guaranteed unless a later signed profile explicitly validates it.

## Stop conditions

Pause the cohort immediately on any failed/unknown device state, duplicated/missing serial, unsigned/mismatched artifact, unexpected partition layout, beta-code replay, credential leakage, or destructive command before the acknowledgement boundary is recorded. Do not “try a generic image.” Preserve redacted evidence and do not continue flashing.

## Evidence ledger

For each of ten devices retain: participant ID, hashed device ID, profile/version, stock fingerprint, host OS/version, installer/release version, signed artifact hashes, timestamps for scan/license/modification, result of each diagnostic, cold-boot results, restoration result if used, and reviewer. Evidence must demonstrate at least five successful Windows and five successful macOS installations.

## Exit review

Public sales remain off until every launch-gate row has evidence and two reviewers approve it. Promo redemption count alone is not installation success. Resolve or restore every device, confirm serial uniqueness, sign every observed profile, complete the adversarial suite, verify official echOS restoration, close high/critical dependency findings, and archive a signed release-evidence bundle.
