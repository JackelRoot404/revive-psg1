# Compatibility checker production cutover

Use this checklist when publishing the public read-only compatibility checker. Browser unlock, Early Access activation, and flashing stay closed via `COMPATIBILITY_CHECKER_ONLY=true` on the API and `NEXT_PUBLIC_COMPATIBILITY_CHECKER_ONLY=true` on Netlify.

## 1. Secure the release signing key

The offline Ed25519 private key lives in macOS Keychain under service name `revive-release-key`. Do not commit `.pem` files.

Keep a durable signed profile envelope outside `/tmp`, for example:

```bash
mkdir -p ~/revive-signing
cp /tmp/psg1-rk3588s-v11-api35-v1.signed.json ~/revive-signing/
rm -f /tmp/revive-release-key.pem /tmp/revive-release-key.pub.pem /tmp/psg1-rk3588s-v11-api35-v1.signed.json
```

## 2. Atomic DigitalOcean cutover

Apply both steps in the same maintenance window.

### A. Update App Platform secret

Set `RELEASE_PUBLIC_KEY_PEM` to the new public key:

```text
-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAJLMd3//Bo9wUw0tx5waU+UjeuOWMtxDO5oiz3+Q1850=
-----END PUBLIC KEY-----
```

In the App Platform UI, paste the PEM with real newlines or escaped `\n` as your other secrets use.

Confirm these runtime env vars remain:

- `COMPATIBILITY_CHECKER_ONLY=true`
- `PUBLIC_SALES_ENABLED=false`
- `EARLY_ACCESS_FREE=true`
- `ALLOWED_ORIGINS=https://revivepsg.com,https://www.revivepsg.com`

Redeploy the API after updating secrets.

### B. Upsert the signed profile into production PostgreSQL

From a machine that can reach the production database with the migration/runtime role:

```bash
DATABASE_URL='postgresql://…' \
  node tools/insert-compatibility-profile.mjs ~/revive-signing/psg1-rk3588s-v11-api35-v1.signed.json
```

The helper deactivates other profile rows and upserts `psg1-rk3588s-v11-api35-v1` as active.

## 3. Netlify web deployment

Set production env vars:

- `NEXT_PUBLIC_SITE_URL=https://revivepsg.com`
- `NEXT_PUBLIC_API_URL=https://api.revivepsg.com`
- `NEXT_PUBLIC_COMPATIBILITY_CHECKER_ONLY=true`
- `NEXT_PUBLIC_SALES_STATE=closed`
- `EARLY_ACCESS_FREE=true`
- `NEXT_PUBLIC_LEGAL_ENTITY=biccsdev`
- `NEXT_PUBLIC_SUPPORT_URL=https://discord.gg/QWYxkJgEHH`

Deploy from the repository root using `netlify.toml`.

## 4. Smoke tests

1. `curl -fsS https://api.revivepsg.com/healthz`
2. Open `https://revivepsg.com/wizard` in desktop Chrome or Edge.
3. Run a supported PSG1 scan and confirm the wizard ends on **Compatible for a future Revive unlock** with no activation button.
4. Confirm installer routes fail closed:
   - `POST /v1/early-access/activate` → `403` / `COMPATIBILITY_CHECKER_ONLY`
   - `GET /v1/releases/stable` → `403` / `COMPATIBILITY_CHECKER_ONLY`

## 5. Re-signing later

```bash
REVIVE_OFFLINE_SIGNING_KEY_PEM="$(security find-generic-password -w -s revive-release-key)" \
  node tools/sign-document.mjs profiles/psg1-rk3588s-v11.template.json \
  > ~/revive-signing/psg1-rk3588s-v11-api35-v1.signed.json

DATABASE_URL='postgresql://…' \
  node tools/insert-compatibility-profile.mjs ~/revive-signing/psg1-rk3588s-v11-api35-v1.signed.json
```

When the browser installer opens publicly, set `COMPATIBILITY_CHECKER_ONLY=false` on the API and `NEXT_PUBLIC_COMPATIBILITY_CHECKER_ONLY=false` on Netlify together.
