# Tester launch checklist

## Publish the website

- [ ] Create the Netlify project from `biccsdev/revive-psg1` and keep public sales `closed`.
- [ ] Point `revivepsg.com` and `www.revivepsg.com` from Namecheap to Netlify.
- [ ] Provision the DigitalOcean App Platform API, Managed PostgreSQL, Managed Valkey, and private Spaces bucket.
- [ ] Point `api.revivepsg.com` to App Platform and restrict CORS to the production Netlify domains.
- [ ] Configure production environment secrets and confirm `/health` and `/ready` over HTTPS.
- [ ] Apply all PostgreSQL migrations and run the idempotent seed.
- [ ] Complete governing-law, effective-date, and data-retention values on Privacy and Terms pages.

The marketing site can go live while checkout and destructive installation remain closed.

## Finish the browser installer before device testers

- [ ] Record WebUSB descriptors and serial visibility for Android ADB, recovery ADB, bootloader Fastboot, and Fastbootd.
- [ ] Repeat the complete USB-mode test on a clean Windows Chrome/Edge host and a clean macOS Chrome/Edge host.
- [ ] Implement Fastboot `max-download-size`, sparse-image streaming, download resume, local SHA-256 verification, and interruption-safe journaling.
- [ ] Require the exact wipe/security confirmation immediately before marking `installation_started_at`.
- [ ] Verify signed profile, release manifest, vbmeta, system image, and every APK before modification.
- [ ] Test cable disconnect, tab close, browser crash, expired installer token, low battery, insufficient browser storage, wrong device, and device swap.
- [ ] Test two cold boots, controls, Wi-Fi, audio, storage, Aurora Store, RetroArch, diagnostics, and fingerprint detection.
- [ ] Obtain and test a lawful Google Play distribution path before advertising Play Store. Until then, do not distribute GMS.
- [ ] Record the irreversible-risk acknowledgement and exact `ERASE PSG1` confirmation. No echOS recovery artifact is provided.

## Code and entitlement testing

- [ ] Complete injected-extension E2E with current Phantom and Solflare.
- [ ] Verify a copied or expired browser session cannot authorize another PSG1.
- [ ] Verify expired/reused codes, device swaps, duplicate device entitlements, and the 25th/26th redemption boundary fail.
- [ ] Verify browser-session and installer tokens cannot be replayed on another PSG1.
- [ ] Use the single database-backed hardware-pilot code first when stock validation is pending; issue cohort codes only after its evidence passes.

## Ten-device safety beta

- [ ] Recruit up to 25 independent PSG1 owners through Discord.
- [ ] Run the free scan first and issue an invite only after the firmware profile is supported.
- [ ] Confirm the bootloader serial is present and unique across all ten devices.
- [ ] Retain only hashed device IDs and redacted reports.
- [ ] Supervise every destructive beta installation in its Discord ticket.
- [ ] Stop enrollment immediately after any failed or unknown device state.
- [ ] Keep public sales disabled permanently; this beta is free.

## Operations

- [ ] Configure API health, latency, payment anomaly, license anomaly, database, and storage alerts.
- [ ] Test PostgreSQL backup restoration and document the recovery time.
- [ ] Confirm private Spaces URLs expire and support range requests.
- [ ] Publish support expectations and incident updates in `https://discord.gg/QWYxkJgEHH`.
- [ ] Perform a final dependency, secret, CodeQL, release-signature, and production-header review.
