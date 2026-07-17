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
- [ ] Test two cold boots, controls, Wi-Fi, audio, storage, Aurora Store, F-Droid, RetroArch, and fingerprint detection.
- [ ] Obtain and test a lawful Google Play distribution path before advertising Play Store. Until then, do not distribute GMS.
- [ ] Build and test a device restoration path. Public destructive testing remains blocked without a verified recovery artifact.

## Payment and wallet testing

- [ ] Complete injected-extension E2E with current Phantom and Solflare.
- [ ] Verify a copied or expired browser session cannot authorize another PSG1.
- [ ] Verify wrong wallet, wrong USDC mint, wrong amount, reused reference, reused transaction, and non-finalized payment all fail.
- [ ] Verify the post-payment installer challenge can only be signed by the receipt wallet and cannot be replayed.
- [ ] Use device-bound private beta invites for the first ten testers; do not require beta testers to send mainnet funds.

## Ten-device safety beta

- [ ] Recruit ten independent PSG1 owners through Discord and X.
- [ ] Run the free scan first and issue an invite only after the firmware profile is supported.
- [ ] Confirm the bootloader serial is present and unique across all ten devices.
- [ ] Retain only hashed device IDs and redacted reports.
- [ ] Supervise every destructive beta installation and keep a recovery operator available.
- [ ] Stop enrollment immediately if any device remains unrecovered.
- [ ] Do not enable 19 USDC public sales until all launch gates have reviewed evidence.

## Operations

- [ ] Configure API health, latency, payment anomaly, license anomaly, database, and storage alerts.
- [ ] Test PostgreSQL backup restoration and document the recovery time.
- [ ] Confirm private Spaces URLs expire and support range requests.
- [ ] Publish support expectations and incident updates in `https://discord.gg/QWYxkJgEHH`.
- [ ] Perform a final dependency, secret, CodeQL, release-signature, and production-header review.
