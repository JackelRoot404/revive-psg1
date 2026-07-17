import { describe, expect, it } from "vitest";
import { classifyInstallationState, deviceIdForSerial, isExpectedUsbDisconnect, normalizeSerial, parseCpuInfoSerial, parseFastbootResponse, parseFastbootSize, parseFastbootUnlocked, parseFastbootVariable } from "./webusb-psg1";

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

  it("recognizes only expected USB teardown errors after an intentional reboot", () => {
    expect(isExpectedUsbDisconnect(new DOMException("The device was disconnected.", "NetworkError"))).toBe(true);
    expect(isExpectedUsbDisconnect(new Error("Fastboot rejected the command"))).toBe(false);
  });
});
