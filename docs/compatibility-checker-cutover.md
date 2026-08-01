# Public installer cutover

`INSTALLER_MODE` is the sole availability switch. The static web site always
runs the read-only scan and renders the API's decision; it must never be given
a separate destructive feature flag.

## 1. Prepare immutable release inputs

Before changing the API mode, complete
[`universal-public-release.md`](universal-public-release.md):

- offline-sign the universal stock PSG1 profile and matching release manifest;
- include the signed allowlisted `flashPlan`;
- upload every hashed private artifact to production object storage;
- record approved public release evidence; and
- publish the narrowly targeted signed Windows Fastboot driver package.

Do not replace these inputs with template JSON, a broad Rockchip driver, or a
generic OTA/downgrade package.

## 2. Deploy while read-only

1. Deploy the API and web code with `INSTALLER_MODE=scan_only`.
2. Set `RELEASE_PUBLIC_KEY_PEM` to the offline profile/release verification
   public key.
3. Upsert every signed profile. Multiple active profiles are supported; their
   signed priorities must not tie for the same device.
4. Insert active release manifests with
   `tools/insert-release-manifest.mjs`. Each manifest must name the profile IDs
   it serves; the insertion tool deactivates only overlapping profile releases.
5. Confirm a supported stock scan returns a `decision` with
   `profile: matched`, `preflight: passed`, `installerMode: scan_only`, and
   `canInstall: false`.
6. Confirm all activation, release, and destructive routes still deny new
   installation starts.

## 3. Open free public access

Change only the API runtime environment:

```text
INSTALLER_MODE=public
INSTALLER_NEW_STARTS_ENABLED=true
```

The service permits public activation only for a `stock_locked` session with a
matched, preflight-passing profile and a public-evidence-ready release bound to
that profile. No Discord code, wallet, payment, or browser deployment is
required.

## 4. Emergency response

Set `INSTALLER_NEW_STARTS_ENABLED=false` to pause only new destructive
boundaries while retaining authenticated resume for already-started PSG1s. Set
`INSTALLER_MODE=scan_only` as the broader emergency mode: it denies new
activation/downloads but still permits an already-started device to retrieve
its exact active signed release. Do not remove that matching release or its
artifact objects while a resume may be needed.
