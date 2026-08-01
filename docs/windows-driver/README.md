# PSG1 Windows Fastboot driver package

This directory defines the release contract for the first-party Windows driver
used by the Revive browser installer. It is deliberately a source/documentation
directory, not a place to commit a generic driver binary.

## Scope

The package binds **WinUSB** to the PSG1 Fastboot interface marketed by Windows
as `USB Download Gadget`. It must target the exact, captured PSG1 Fastboot
hardware ID and interface only. It must never match:

- a bare Rockchip vendor ID;
- `Android ADB Interface`;
- recovery ADB; or
- any unrelated USB device.

## Required release inputs

1. Capture the actual `Hardware Ids`, compatible IDs, interface number, VID,
   PID, and serial behavior from a stock PSG1 in Fastboot on clean Windows 10
   and Windows 11 hosts.
2. Substitute those exact IDs into `psg1-fastboot-winusb.inf.template`.
3. Add a stable `DeviceInterfaceGUIDs` value, build the package, and sign the
   catalog through the Microsoft Windows hardware-signing process.
4. Package the signed INF/CAT in a signed, UAC-elevated installer. Record the
   executable and catalog SHA-256 values in the published release evidence.
5. Test install, uninstall, Chrome, Edge, reboot-to-Fastboot enumeration, and
   a full read-only scan on clean Windows hosts.

Only after those steps may the production wizard link to the package. Until
then, the product may show the temporary explicit support procedure, but must
not present it as an all-Windows solution.

## Verification checklist

- The package's Authenticode signer is the published Revive signing identity.
- Device Manager shows WinUSB only for the selected PSG1 Fastboot interface.
- Android ADB continues to work after installation.
- A non-PSG1 Rockchip device does not match the INF.
- The WebUSB picker contains the PSG1 in Fastboot and `USBDevice.open()` works.
