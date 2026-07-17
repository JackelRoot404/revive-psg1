# Private beta runbook

## Entry criteria

- Counsel-approved beta terms, privacy notice, support identity, and incident contact exist.
- The tested profile, release manifest, system/vbmeta artifacts, desktop installers, and restoration artifacts have independent signatures and recorded hashes.
- Google-app redistribution and trademark usage are either authorized or removed from the distributed artifact/product claims.
- A restore drill has succeeded on the exact profile and no beta device is in an unknown state.
- Payment remains disabled. Only manually approved, device-bound, one-time beta invites under the atomically capped `BICCSDEV` program are available. The word `BICCSDEV` alone is never accepted at checkout.

## Enroll one device

1. Record a participant ID, host OS, PSG1 stock build, and consent to submit the redacted report. Never copy the raw serial into the tracking sheet.
2. Have the participant download the signed installer from the configured first-party URL and verify the OS publisher signature.
3. Run the read-only scan. Stop on unknown firmware, serial mismatch, missing recovery path, low battery, insufficient host space, or unstable USB.
4. After reviewing the redacted scan, set `BETA_DEVICE_ID` to its 64-character device hash and run `npm run db:beta-invite -w @revive-psg1/api` with production secrets. Optionally set `BETA_INVITE_EXPIRES_AT` and `BETA_INVITE_LABEL`. Deliver the shown-once `rpb_…` invite privately; never store it in tickets or logs.
5. Redeem that device-bound invite. Confirm the invite is consumed once and the global count increased by exactly one; a copied invite, different device, duplicate device, or eleventh redemption must not consume a seat.
6. Capture the wipe acknowledgement and local recovery-report identifier. Never request the participant's PIN, wallet seed phrase, Google password, recovery credential, or raw ADB log.
7. Run installation and two cold boots. Record pass/fail for controls, Wi-Fi, audio, storage, application installation, and recovery. Test Google check-in only when a lawful release-approved customer-supplied artifact was selected locally; Revive never distributes or receives it. Fingerprint is recorded as unvalidated/not guaranteed unless a later signed profile explicitly validates it.
8. Have the participant save the shown-once `rpr_…` recovery credential, then confirm the permanent entitlement recovers on a different computer using the same physical PSG1 and credential without the original wallet.

## Stop conditions

Pause the cohort immediately on any brick/unrecovered device, duplicated/missing serial, unsigned/mismatched artifact, unexpected partition layout, payment/promo replay, credential leakage, or destructive command before the refund boundary is recorded. Do not “try a generic image.” Preserve redacted evidence and use only the tested restoration path.

## Evidence ledger

For each of ten devices retain: participant ID, hashed device ID, profile/version, stock fingerprint, host OS/version, installer/release version, signed artifact hashes, timestamps for scan/license/modification, result of each diagnostic, cold-boot results, restoration result if used, and reviewer. Evidence must demonstrate at least five successful Windows and five successful macOS installations.

## Exit review

Public sales remain off until every launch-gate row has evidence and two reviewers approve it. Promo redemption count alone is not installation success. Resolve or restore every device, confirm serial uniqueness, sign every observed profile, complete the adversarial suite, verify official echOS restoration, close high/critical dependency findings, and archive a signed release-evidence bundle.
