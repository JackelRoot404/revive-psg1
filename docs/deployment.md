# Historical deployment reference

> Hosted operation ended on 2026-08-10. This file is retained for community
> research; it does not describe a currently supported service.

> **Current release posture:** deploy and operate this service with
> `INSTALLER_MODE=scan_only`. The code supports a future public path, but this
> repository does not yet provide trusted PSG1 hardware attestation, production
> release artifacts/evidence, a signed PSG1-only Windows driver, or the required
> physical Windows/macOS validation. Setting an environment variable cannot
> create those prerequisites.

## Netlify

Connect the repository root. `netlify.toml` builds the `@revive-psg1/web` workspace and lets Netlify's current Next.js adapter package the application. Configure only:

- `NEXT_PUBLIC_SITE_URL=https://revivepsg.com`
- `NEXT_PUBLIC_API_URL=https://api.revivepsg.com`
- `NEXT_PUBLIC_SOLANA_RPC_URL=<public browser-safe mainnet RPC>`
- Do not set a browser environment driver URL. When a future public release is
  ready, the wizard can expose a Windows driver link only after it verifies an
  active signed release envelope's exact package URL, hardware IDs, catalog
  hash, installer hash, and Authenticode signer. No production driver package
  is included in this repository.
- Signed HTTPS `NEXT_PUBLIC_MACOS_DOWNLOAD_URL` and `NEXT_PUBLIC_WINDOWS_DOWNLOAD_URL` only after publisher-signature verification.
- `NEXT_PUBLIC_LEGAL_ENTITY=biccsdev` and `NEXT_PUBLIC_SUPPORT_URL=https://github.com/biccsdev/revive-psg1/issues`.
- Counsel-approved `NEXT_PUBLIC_GOVERNING_LAW`, `NEXT_PUBLIC_LEGAL_EFFECTIVE_DATE`, and `NEXT_PUBLIC_DATA_RETENTION_POLICY`.

Never put database, Spaces, signing, RPC-provider secret, or license credentials in Netlify. Restrict the production API CORS allowlist to the final Netlify custom domains.

## DigitalOcean App Platform

Create these managed resources in the same region:

- PostgreSQL with transaction pooling and point-in-time recovery.
- Valkey for rate limits and short-lived replay state.
- A private Spaces bucket with CORS disabled; downloads use one-hour presigned URLs.

Create beta from `apps/api/.do/app.yaml`; use `app.production.yaml` only after launch review. Replace every placeholder, add Managed Database/Valkey connection strings as encrypted App Platform secrets, and provide the managed PostgreSQL CA as `DATABASE_CA_PEM`. Production startup fails unless CA verification, license issuance keys, and the offline release public key exist.

Before the first deployment:

1. Restrict PostgreSQL trusted sources to the App Platform service, use the transaction-pool endpoint, and create separate runtime, migration, and read-only roles. Give runtime no schema or role-management privileges.
2. Restrict Valkey to trusted sources and require TLS. It holds disposable short-lived state, not the source of truth for orders or licenses.
3. Make Spaces private, disable public listing/browser CORS, create a least-privilege artifact-read key, and enable suitable versioning/retention for signed releases.
4. Put runtime credentials only in encrypted App Platform secrets. Never commit secret values to either YAML template.
5. Configure deployment/domain/restart/memory alerts and an external synthetic check. Document log access and retention.

Beta runs one container. Public launch should change App Platform scaling to minimum 2, maximum 10, with request autoscaling around 25 requests/second per instance. Alert when P95 exceeds 500 ms; App Platform autoscaling itself should use the supported CPU/request metric available for the selected plan. The PostgreSQL client caps each instance at ten connections.

Run migrations as a one-off job with the migration role, not from every web process.
Local Docker can use `npm run db:migrate` (`drizzle-kit`). DigitalOcean managed
Postgres cannot create Drizzle's bookkeeping schema, so production must build
the API and apply the idempotent runtime migrator instead:

```bash
npm run build -w @revive-psg1/api
npm run db:migrate:runtime -w @revive-psg1/api
npm run db:seed -w @revive-psg1/api
```

The website has no installation feature flag. The API remains authoritative:
`INSTALLER_MODE=scan_only` shows read-only results and denies activation, new
installation, destructive boundaries, and artifact downloads.
`INSTALLER_MODE=public` is implemented as the future free, device-bound path
for a stock-locked, preflight-passing PSG1 with a matching signed public release;
it must not be enabled until trusted hardware attestation is in place. Browser
USB/ADB/Fastboot observations and the cross-mode serial match are not that
attestation.

`INSTALLER_NEW_STARTS_ENABLED=false` is the runtime emergency brake for new
destructive boundaries; it preserves only an exact, authenticated resume for a
device that already crossed its recorded boundary. A Fastboot-only recovery
also needs the expiring resume credential stored in the same-origin browser
journal; it remains stable until expiry and can restore only the existing
release binding.

Do not set `INSTALLER_MODE=public` until the signed profile, production release,
private artifact objects, public evidence, trusted hardware-attestation service,
and PSG1-only Windows driver package described in
[`universal-public-release.md`](universal-public-release.md) are present and
the physical-host test evidence has passed independent review.

Public sales remain disabled. The public installer has no checkout, wallet, or
payment path.

## DNS and traffic

- Apex/www → Netlify.
- `api.revivepsg.com` → App Platform custom domain.
- Large artifacts → Spaces presigned URLs; they never transit API containers.
- Configure two independent Solana mainnet RPC vendors. Verification fails closed if finalized transaction data is unavailable.

Restore the database into a disposable cluster quarterly, test artifact presigning monthly, and alert on payment replay conflicts, promo exhaustion attempts, license issuance spikes, and repeated signature/hash failures.

## Deployment verification

- Check `/healthz`, then run read-only supported and unsupported scans against staging.
- Confirm CORS rejects an unlisted origin and accepts only exact production Netlify origins.
- Confirm the wizard uses `no-store`, serves CSP, and rejects copied or expired browser-session tokens.
- Confirm PostgreSQL CA/hostname validation, trusted-source blocking, role restrictions, PITR, and a disposable restore.
- Confirm private URLs expire, support range requests, and never send artifact bytes through API containers.
- Confirm `scan_only` denies public activation, new boundaries, Fastboot-only resume tokens for unstarted devices, and artifact downloads even when signed templates exist.
- Keep new installation/downloads off if any check fails. Roll back the application revision; never mutate a signed artifact in place.
