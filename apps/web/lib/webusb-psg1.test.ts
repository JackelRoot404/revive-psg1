import { describe, expect, it } from "vitest";
import { classifyInstallationState, deviceIdForSerial, finalizeWebScan, isExpectedUsbDisconnect, normalizeSerial, parseCpuInfoSerial, parseDfKilobytes, parseFastbootResponse, parseFastbootSize, parseFastbootUnlocked, parseFastbootVariable, WebFastbootPsg1, type AdbCompatibilityScan } from "./webusb-psg1";

describe("PSG1 WebUSB transport primitives", () => {
  it("normalizes and hashes the same manufacturer serial deterministically", async () => {
    expect(normalizeSerial(" psg1-test_0001-a ")).toBe("PSG1TEST0001A");
    await expect(deviceIdForSerial("PSG1-TEST-0001-A")).resolves.toMatch(/^[a-f0-9]{64}$/u);
    expect(await deviceIdForSerial("PSG1-TEST-0001-A")).toBe(await deviceIdForSerial("psg1_test 0001_a"));
  });

  it("extracts the immutable Rockchip serial from Android CPU information", () => {
    expect(parseCpuInfoSerial("processor : 0\nSerial : 2129c17e0292269d\nHardware : RK3588S\n")).toBe("2129C17E0292269D");
    expect(parseCpuInfoSerial("processor : 0\nHardware : RK3588S\n")).toBe("");
  });

  it("parses only allowlisted Fastboot response statuses", () => {
    expect(parseFastbootResponse(new TextEncoder().encode("OKAY0x1000"))).toEqual({ status: "OKAY", payload: "0x1000" });
    expect(() => parseFastbootResponse(new TextEncoder().encode("NOPE"))).toThrow(/unknown status/u);
  });

  it("accepts bounded decimal and hexadecimal partition sizes", () => {
    expect(parseFastbootSize("0x1000")).toBe(4096);
    expect(parseFastbootSize("4096")).toBe(4096);
    expect(parseFastbootSize("not-a-size")).toBe(0);
  });

  it("reads the mounted Android system size from df output", () => {
    expect(parseDfKilobytes("Filesystem 1K-blocks Used Available Use% Mounted on\n/dev/block/dm-0 3906250 2000000 1906250 52% /system\n")).toBe(4_000_000_000);
    expect(parseDfKilobytes("invalid")).toBe(0);
  });

  it("removes getvar labels emitted through Fastboot INFO responses", () => {
    expect(parseFastbootVariable("serialno", "serialno: 2129c17e0292269d")).toBe("2129c17e0292269d");
    expect(parseFastbootVariable("partition-size:system", "(bootloader) partition-size:system: 0x1000")).toBe("0x1000");
    expect(parseFastbootVariable("serialno", "unrelated status\n(bootloader) serialno: 2129c17e0292269d\n")).toBe("2129c17e0292269d");
    expect(parseFastbootVariable("unlocked", "yes")).toBe("yes");
  });

  it("classifies Lineage from the actual system props even when vendor props remain stock", () => {
    expect(classifyInstallationState({
      systemBuildFingerprint: "generic/lineage_gsi_arm64_gN/lineage_gsi_arm64:15/build:userdebug/release-keys",
      vendorBuildFingerprint: "PlaySolana/PSG1/PSG1:15/build/playsolana-20260521-145647:user/release-keys",
      systemBuildIncremental: "1750492249",
      systemBuildType: "userdebug",
      lineageVersion: "22.2-UNOFFICIAL",
      bootloaderUnlocked: true
    })).toBe("already_modified");
  });

  it("keeps stock lock state explicit and parses common Fastboot values", () => {
    const stock = {
      systemBuildFingerprint: "PlaySolana/PSG1/PSG1:15/build/playsolana-20260521-145647:user/release-keys",
      vendorBuildFingerprint: "PlaySolana/PSG1/PSG1:15/build/playsolana-20260521-145647:user/release-keys",
      systemBuildIncremental: "playsolana-20260521-145647",
      systemBuildType: "user",
      lineageVersion: ""
    };
    expect(classifyInstallationState({ ...stock, bootloaderUnlocked: false })).toBe("stock_locked");
    expect(classifyInstallationState({ ...stock, bootloaderUnlocked: true })).toBe("stock_unlocked");
    expect(parseFastbootUnlocked("yes")).toBe(true);
    expect(parseFastbootUnlocked("locked")).toBe(false);
    expect(parseFastbootUnlocked("unknown")).toBeNull();
  });

  it("keeps the generic Fastboot flashing lock distinct from PSG1 verified-boot state", () => {
    expect(parseFastbootUnlocked("no")).toBe(false);
    expect(classifyInstallationState({
      systemBuildFingerprint: "generic/lineage_gsi_arm64_gN/lineage_gsi_arm64:15/build:userdebug/release-keys",
      vendorBuildFingerprint: "PlaySolana/PSG1/PSG1:15/build/playsolana-20260521-145647:user/release-keys",
      systemBuildIncremental: "1750492249",
      systemBuildType: "userdebug",
      lineageVersion: "22.2-UNOFFICIAL",
      bootloaderUnlocked: true
    })).toBe("already_modified");
  });

  it("uses the Fastboot protocol serial when a browser descriptor serial is stale", async () => {
    const transport = {
      normalizedUsbSerial: "STALE_BROWSER_DESCRIPTOR",
      getVariable: async () => "PSG1-TEST-0001"
    };
    await expect(WebFastbootPsg1.prototype.assertIdentity.call(transport, "psg1_test_0001")).resolves.toBeUndefined();
  });

  it("never substitutes a browser USB descriptor for the Fastboot protocol serial", async () => {
    const transport = {
      normalizedUsbSerial: "PSG1-TEST-0001",
      getVariable: async () => ""
    };
    await expect(WebFastbootPsg1.prototype.assertIdentity.call(transport, "psg1_test_0001"))
      .rejects.toThrow(/protocol serial number/u);
  });

  it("requires bootloader Fastboot and a matching CPU-to-protocol serial for a completed scan", async () => {
    const adb: AdbCompatibilityScan = {
      product: "PSG1", model: "PSG1", board: "RK3588S PSG1", hardware: "rk3588",
      buildFingerprint: "PlaySolana/PSG1/PSG1:15/build:user/release-keys", buildIncremental: "1.1.23",
      systemBuildFingerprint: "PlaySolana/PSG1/PSG1:15/build:user/release-keys",
      vendorBuildFingerprint: "PlaySolana/PSG1/PSG1:15/build:user/release-keys", systemBuildIncremental: "1.1.23",
      systemBuildType: "user", lineageVersion: "", bootloaderUnlocked: false, installationState: "stock_locked",
      androidApiLevel: 35, vendorApiLevel: 35, batteryPercent: 80, charging: true, usbStable: true,
      recoveryCapable: true, hostBytesAvailable: 8_000_000_000, systemPartitionBytes: 4_000_000_000,
      bootloaderSerialCandidate: "PSG1CPU0001"
    };
    const selectedModes: string[] = [];
    const fastboot = {
      normalizedUsbSerial: "STALE_DESCRIPTOR",
      assertMode: async (mode: string) => { selectedModes.push(mode); },
      getVariable: async (name: string) => name === "serialno" ? "PSG1-CPU-0001" : "54975528960"
    };
    const completed = await finalizeWebScan(adb, fastboot as never);
    expect(selectedModes).toEqual(["bootloader"]);
    expect(completed.bootloaderSerial).toBe("PSG1CPU0001");
    expect(completed.fastbootUsbDescriptorVerified).toBe(false);
    expect(completed.serialVerified).toBe(true);
  });

  it("recognizes only expected USB teardown errors after an intentional reboot", () => {
    expect(isExpectedUsbDisconnect(new DOMException("The device was disconnected.", "NetworkError"))).toBe(true);
    expect(isExpectedUsbDisconnect(new Error("Fastboot rejected the command"))).toBe(false);
  });
});
