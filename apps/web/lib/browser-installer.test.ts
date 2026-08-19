import { describe, expect, it } from "vitest";
import { assertFreshStockLockedPsg1Preflight, assertPsg1FastbootdCapacity, assertPsg1FlashPlan } from "./browser-installer";
import type { Psg1FlashPlan } from "@revive-psg1/contracts";
import type { AdbCompatibilityScan, WebCompatibilityScan } from "./webusb-psg1";

const plan: Psg1FlashPlan = {
  version: 1,
  target: "PSG1",
  requiredInstallationState: "stock_locked",
  unlockCommand: "fastboot oem at-unlock-vboot",
  vbmetaPartition: "vbmeta",
  systemPartition: "system",
  systemMode: "fastbootd",
  minimumSystemBytes: 4_000_000_000,
  minimumSuperPartitionBytes: 54_975_528_960,
  resizeLogicalSystem: true,
  wipeUserData: true,
  postFlashApkComponents: ["diagnostics", "diagnostics_test", "aurora_store", "retroarch"],
  requiredColdBoots: 2,
  diagnosticsCommand: ["am", "instrument", "-w", "com.revivepsg1.diagnostics.test/androidx.test.runner.AndroidJUnitRunner"]
};

describe("signed PSG1 flash plan", () => {
  it("allows the single reviewed PSG1 command set", () => {
    expect(() => assertPsg1FlashPlan(plan)).not.toThrow();
  });

  it("rejects a substituted unlock or system partition", () => {
    expect(() => assertPsg1FlashPlan({ ...plan, unlockCommand: "fastboot flashing unlock" } as never)).toThrow(/unsupported PSG1 flash plan/u);
    expect(() => assertPsg1FlashPlan({ ...plan, systemPartition: "vendor" } as never)).toThrow(/unsupported PSG1 flash plan/u);
  });

  it("refuses a stale or no-longer-stock PSG1 before the first signed reboot", () => {
    const scan: WebCompatibilityScan = {
      deviceId: "a".repeat(64), bootloaderSerial: "PSG1CPU0001", product: "PSG1", model: "PSG1",
      board: "RK3588S PSG1", hardware: "rk3588", buildFingerprint: "PlaySolana/PSG1/PSG1:15/build:user/release-keys",
      buildIncremental: "1.1.23", systemBuildFingerprint: "PlaySolana/PSG1/PSG1:15/build:user/release-keys",
      vendorBuildFingerprint: "PlaySolana/PSG1/PSG1:15/build:user/release-keys", systemBuildIncremental: "1.1.23",
      systemBuildType: "user", lineageVersion: "", bootloaderUnlocked: false, installationState: "stock_locked",
      androidApiLevel: 35, vendorApiLevel: 35, batteryPercent: 80, charging: false, serialVerified: true,
      immutableSerialVerified: true, fastbootUsbDescriptorVerified: false, usbStable: true, recoveryCapable: true,
      hostBytesAvailable: 8_000_000_000, systemPartitionBytes: 4_000_000_000, superPartitionBytes: 54_975_528_960
    };
    const { deviceId: _deviceId, bootloaderSerial, superPartitionBytes: _superPartitionBytes, serialVerified: _serialVerified,
      immutableSerialVerified: _immutableSerialVerified, fastbootUsbDescriptorVerified: _fastbootUsbDescriptorVerified, ...adbValues } = scan;
    const fresh: AdbCompatibilityScan = { ...adbValues, bootloaderSerialCandidate: bootloaderSerial };

    expect(() => assertFreshStockLockedPsg1Preflight(fresh, scan, plan)).not.toThrow();
    expect(() => assertFreshStockLockedPsg1Preflight({ ...fresh, installationState: "stock_unlocked", bootloaderUnlocked: true }, scan, plan))
      .toThrow(/no longer a stock-locked/u);
    expect(() => assertFreshStockLockedPsg1Preflight({ ...fresh, batteryPercent: 12, charging: false }, scan, plan))
      .toThrow(/Charge the PSG1/u);
    expect(() => assertFreshStockLockedPsg1Preflight({ ...fresh, systemPartitionBytes: 3_000_000_000 }, scan, plan))
      .toThrow(/partition layout changed/u);
  });

  it("accepts a stock mount smaller than the replacement-image capacity", () => {
    const scan: WebCompatibilityScan = {
      deviceId: "a".repeat(64), bootloaderSerial: "PSG1CPU0001", product: "PSG1", model: "PSG1",
      board: "RK3588S PSG1", hardware: "rk3588", buildFingerprint: "PlaySolana/PSG1/PSG1:15/build:user/release-keys",
      buildIncremental: "1.1.23", systemBuildFingerprint: "PlaySolana/PSG1/PSG1:15/build:user/release-keys",
      vendorBuildFingerprint: "PlaySolana/PSG1/PSG1:15/build:user/release-keys", systemBuildIncremental: "1.1.23",
      systemBuildType: "user", lineageVersion: "", bootloaderUnlocked: false, installationState: "stock_locked",
      androidApiLevel: 35, vendorApiLevel: 35, batteryPercent: 80, charging: true, serialVerified: true,
      immutableSerialVerified: true, fastbootUsbDescriptorVerified: false, usbStable: true, recoveryCapable: true,
      hostBytesAvailable: 8_000_000_000, systemPartitionBytes: 1_803_378_688, superPartitionBytes: 54_975_528_960
    };
    const { deviceId: _deviceId, bootloaderSerial, superPartitionBytes: _superPartitionBytes, serialVerified: _serialVerified,
      immutableSerialVerified: _immutableSerialVerified, fastbootUsbDescriptorVerified: _fastbootUsbDescriptorVerified, ...adbValues } = scan;
    const fresh: AdbCompatibilityScan = { ...adbValues, bootloaderSerialCandidate: bootloaderSerial };
    expect(() => assertFreshStockLockedPsg1Preflight(fresh, scan, plan)).not.toThrow();
  });

  it("refuses to resize or flash when the signed image exceeds current Fastbootd capacity", () => {
    expect(() => assertPsg1FastbootdCapacity(plan, 3_500_000_000, 54_975_528_960)).not.toThrow();
    expect(() => assertPsg1FastbootdCapacity(plan, 4_100_000_000, 54_975_528_960)).toThrow(/system image exceeds/u);
    expect(() => assertPsg1FastbootdCapacity(plan, 3_500_000_000, 50_000_000_000)).toThrow(/super partition smaller/u);
  });
});
