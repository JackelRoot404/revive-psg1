# PSG1 Google check-in serial normalization

Google check-in rejects the factory PSG1 serial because it contains separators.
These two files provide a device-generic, late-boot correction:

- `revive-psg1-normalize-serial` derives an uppercase alphanumeric value from
  the immutable `ro.boot.serialno` value and changes only `ro.serialno`.
- `revive-psg1-serial.rc` runs the helper only after `sys.boot_completed=1`,
  after USB and ADB have already bound to the unchanged factory serial.

## Production image integration

Place the helper at `/system/bin/revive-psg1-normalize-serial` with mode `0755`
and the init file at `/system/etc/init/revive-psg1-serial.rc` with mode `0644`.
The target image must provide `/system/bin/resetprop_sys` and the `u:r:su:s0`
domain used by the validated PSG1 LineageOS build. Image assembly must fail if
either prerequisite is absent. The release pipeline must sign the resulting
system image and manifest; the installer must never patch a customer's vendor
partition to install this rule.

Before signing a release, verify on every supported profile that:

1. USB, ADB, recovery, and Fastboot still expose the same factory serial.
2. After boot completion, `ro.serialno` is alphanumeric and derived from that
   factory serial without storing it in the image.
3. Google check-in produces a non-zero Android ID and Play Store can install an
   application after two cold boots.

The helper intentionally exits without changing anything when the source is
empty, outside 8–64 characters after normalization, or contains unexpected
characters.
