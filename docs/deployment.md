# Deployment

## Netlify

Connect the repository root. `netlify.toml` builds the `@revive-psg1/web` workspace and lets Netlify's current Next.js adapter package the application. Configure only:

- `NEXT_PUBLIC_SITE_URL=https://revivepsg.com`
- `NEXT_PUBLIC_API_URL=https://api.revivepsg.com`
- `NEXT_PUBLIC_SOLANA_RPC_URL=<public browser-safe mainnet RPC>`
- `EARLY_ACCESS_FREE=true` while the public Early Access program is free.
- `NEXT_PUBLIC_SALES_STATE=closed` until launch review (`beta` or `public` afterward).
- Signed HTTPS `NEXT_PUBLIC_MACOS_DOWNLOAD_URL` and `NEXT_PUBLIC_WINDOWS_DOWNLOAD_URL` only after publisher-signature verification.
- `NEXT_PUBLIC_LEGAL_ENTITY=biccsdev` and `NEXT_PUBLIC_SUPPORT_URL=https://discord.gg/QWYxkJgEHH`.
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

Run migrations as a one-off job with the migration role, not from every web process:

```bash
npm run db:migrate
npm run db:seed -w @revive-psg1/api
```

Keep `EARLY_ACCESS_FREE=true` on both Netlify and the API during free Early Access. The API remains authoritative: supported devices receive an atomic zero-value `early_access` entitlement and paid verification is bypassed. To return the product to paid mode, set `EARLY_ACCESS_FREE=false` on both deployments; no code or database change is required.

Set `PUBLIC_SALES_ENABLED=true` only after two reviewers approve launch evidence and free Early Access has ended. This flag is necessary but insufficient: the API also requires every row in `launch_gate_checks` to be passed. The web source-level same-computer checkout gate and `NEXT_PUBLIC_SALES_STATE` are reviewed separately.

## DNS and traffic

- Apex/www → Netlify.
- `api.revivepsg.com` → App Platform custom domain.
- Large artifacts → Spaces presigned URLs; they never transit API containers.
- Configure two independent Solana mainnet RPC vendors. Verification fails closed if finalized transaction data is unavailable.

Restore the database into a disposable cluster quarterly, test artifact presigning monthly, and alert on payment replay conflicts, promo exhaustion attempts, license issuance spikes, and repeated signature/hash failures.

## Deployment verification

- Check `/healthz`, then run read-only supported and unsupported scans against staging.
- Confirm CORS rejects an unlisted origin and accepts only exact production Netlify origins.
- Confirm checkout uses `no-store`, removes URL fragments immediately, serves CSP, and rejects a copied URL without browser-instance/desktop proof.
- Confirm PostgreSQL CA/hostname validation, trusted-source blocking, role restrictions, PITR, and a disposable restore.
- Confirm private URLs expire, support range requests, and never send artifact bytes through API containers.
- Keep checkout/downloads off if any check fails. Roll back the application revision; never mutate a signed artifact in place.
