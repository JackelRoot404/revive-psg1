# Redacted V11-class PSG1 observation — 2026-08-19

Read-only Android ADB scan of one consenting PSG1. No Fastboot reboot,
unlock, wipe, or flash. Raw serials, CPU serials, USB descriptors that
carry a unit identity, device-binding hashes, host identifiers, and
account data are withheld.

This is not stock-to-unlocked conversion evidence. It is a hardware and
policy observation against the unsigned profile templates.

## Hardware / software class

| Field | Observed (redacted) |
|---|---|
| Product / model | `PSG1` / `PSG1` |
| `ro.soc.model` | `RK3588S` |
| Vendor / TYZC version | `PSG1-RK3588S2-A15-V11.0.1` |
| Computed wizard board identity | `RK3588S` + the V11.0.1 vendor string |
| Android / vendor API | 35 / 35 |
| System type | `user` |
| `ro.lineage.version` | empty |
| System fingerprint prefix | `PlaySolana/PSG1/PSG1:15/AP4A.241205.013.C1/` |
| Incremental | `playsolana-20260625-175944` |
| `ro.boot.flash.locked` | `1` |
| `ro.boot.verifiedbootstate` | `green` |
| `ro.boot.vbmeta.device_state` | `locked` |
| ADB USB VID:PID | `2207:0006` (product gadget, not a unit identity) |

The V11 template `boardPatterns` (`RK3588S.*PSG1.*V11`) and the
universal template (`PSG1`) both match this board identity.

## Partition sizes

| Partition | Bytes | Notes |
|---|---|---|
| `super` | `54975528960` | Exact match to both profile templates |
| Mounted `/system` (`df -k`) | `1803378688` | **Below** template `system.minSize` `2000000000` |
| Logical `system` mapper | `1833246720` | Same class as the mount |

Templates now split those bounds:

- `stockSystem` (1.60–1.99 GiB): observed mounted `/system` on a stock
  V11-class unit. This scan's `1803378688` bytes sits inside that range.
- `system` (2.00–4.29 GiB): replacement image / post-resize logical
  system. Host storage preflight uses this floor, not the live mount.
- Flash-plan `minimumSystemBytes` is the same replacement-image
  capacity. It is no longer compared to the live mounted size.

Userdata on this class is ~64 GiB. That figure is a SKU observation,
not an identity.

## Userspace vs stock classification

PlaySolana fingerprints and a locked/green boot chain remain after
common userspace changes (alternate home launcher, Termux, Echos
package state `enabled=3`). Upstream classification used only
Lineage/GSI fingerprints, so those units were labelled `stock_locked`.

The wizard now treats Termux, Lawnchair, F-Droid, Lawnchair-as-home,
or Echos `User 0 enabled=3` as `already_modified`. That keeps the
public destructive path closed for converted units. It is not a
hardware attestation.

## Other read-only notes

- `fuse.programmed=1` appears on the kernel command line (OTP
  secure-boot fuse programmed).
- `android.hardware.oemlock.IOemLock/default` is not declared in the
  VINTF manifest.
- The string `at-unlock-vboot` was not found in readable `/system` or
  `/vendor` binaries. If that OEM command exists, it lives in the
  bootloader, which this scan did not open.
- `INSTALLER_MODE` must remain `scan_only`. This file does not
  authorize flashing.

## What this does not prove

- Fastboot protocol serial continuity (would require a reboot).
- That `fastboot oem at-unlock-vboot` works on a stock locked unit.
- A reproducible system image or echOS restore path.
- Serial uniqueness across production units.
