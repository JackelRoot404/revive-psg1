# echOS recovery capture — public-release blocker

No verified official echOS restoration image is currently available. Revive
must not represent the LineageOS conversion as reversible until an original
customer device can be captured and restored end-to-end without modifying a
shared or vendor-supplied image.

## Rejected assumption

AOSP fastbootd does not generally permit `fastboot fetch system` or
`fastboot fetch vbmeta`; its fetch allowlist is normally limited to
`vendor_boot` variants. A failed fetch is not a backup and must stop an install
profile that requires recovery capture. The installer does not currently issue
either command or claim that it has created an echOS recovery bundle.

## Beta validation required

Validate one of these **read-only** capture paths on each signed PSG1 profile:

1. Stock echOS `adb root` plus raw, size-bounded partition reads.
2. Rockchip Loader `rkdeveloptool rl` reads with independently verified
   partition offsets and sizes.

Rockchip loader writes, erases, partition-table changes, and generic offsets are
out of scope and prohibited during discovery. Capture must occur before any
unlock/flash that changes the relevant bytes.

A valid local recovery bundle must contain the customer's own required
partitions, signed profile ID, hashed device ID, partition names/sizes, SHA-256
for every image, capture-tool version, and a signed bundle manifest. It must
never be uploaded. Restore must cross-check the attached PSG1 identity, signed
profile, partition ranges, every image hash, and bootloader state before any
write. An interrupted restore must be journaled and resumable.

Public sales and any “restore echOS” UI remain disabled until capture and
restore have both passed on real beta hardware from Windows and macOS.
