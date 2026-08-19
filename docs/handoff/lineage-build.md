# Official LineageOS 22.2 GSI build (host-gated)

This is the continuation of the unfinished
`lineage_gsi_arm64-user` experiment. It is **not** a release, and it
does not authorize flashing. `INSTALLER_MODE` stays `scan_only`.

The previous attempt ran Linux/amd64 Docker through Rosetta, finished
Soong with a 20 GiB `GOMEMLIMIT`, and stopped during `ckati`. No
`system` or target-files output survived. Rebuild from the pinned
manifest; do not resume a deleted tree.

## Host gate

Run this **before** `repo init` or `repo sync`:

```sh
tools/check-lineage-host.sh --path /path/to/lineage-src
```

The script exits 0 only when all of these are true:

| Requirement | Floor |
|---|---|
| Kernel | Linux |
| CPU | native `x86_64` (no ARM host, no Rosetta, no qemu-user) |
| RAM | 32 GiB (`--allow-tight-memory` lowers this to 24 GiB **only** if `0001-soong-bound-primary-builder-memory.patch` will be applied) |
| Free disk on `--path` | 400 GiB |

A 16 GiB / ~200 GiB virtual machine fails this gate. Do not add swap and
hope. Do not start a sync that will fill the disk or OOM other services.

The checker prints only capacity fields. It does not print host names,
user names, or addresses.

## Allowed source

- Official LineageOS 22.2 + AOSP as recorded in
  [`lineage-22.2-pinned-manifest.xml`](lineage-22.2-pinned-manifest.xml).
- Lunch target: `lineage_gsi_arm64-user`.
- Variant: `user`, release keys. Not `userdebug`, not test-keys.
- No Andy Yan, Treble overlay, GApps, Magisk, or insecure-ADB tree.
- No downloaded third-party GSI as a stand-in. Earlier comparisons were
  rejected (GMS in one; userdebug + insecure ADB in another).

## After the host gate passes

These commands are a reminder, not a hosted runbook and not a promise
that the resulting image is flash-safe.

```sh
# on a host that already passed tools/check-lineage-host.sh
mkdir -p lineage-22.2 && cd lineage-22.2
repo init -u https://github.com/LineageOS/android.git -b lineage-22.2 \
  --no-clone-bundle
cp /path/to/revive-psg1/docs/handoff/lineage-22.2-pinned-manifest.xml \
  .repo/manifests/revive-pinned.xml
repo init -m revive-pinned.xml
repo sync -c -j4 --no-clone-bundle

# only if the host used --allow-tight-memory
patch -p1 < /path/to/revive-psg1/docs/handoff/0001-soong-bound-primary-builder-memory.patch

source build/envsetup.sh
lunch lineage_gsi_arm64-user
m -j"$(nproc)"
```

Keep the Soong patch off any 32 GiB+ host. It only changes graph-builder
GC pressure.

## What this still does not produce

- A signed, license-reviewed, GMS-inspected release artifact
- AVB/vbmeta material for a PSG1
- Proof that `fastboot oem at-unlock-vboot` works on a stock locked unit
- An echOS restore image

Do not copy `out/` images into git. Do not enable `INSTALLER_MODE=public`
because a build finished.
