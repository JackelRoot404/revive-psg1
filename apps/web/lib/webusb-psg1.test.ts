import { describe, expect, it } from "vitest";
import { classifyInstallationState, deviceIdForSerial, normalizeSerial, parseFastbootResponse, parseFastbootSize, parseFastbootUnlocked } from "./webusb-psg1";

describe("PSG1 WebUSB transport primitives", () => {
  it("normalizes and hashes the same manufacturer serial deterministically", async () => {
    expect(normalizeSerial(" psg1-test_0001-a ")).toBe("PSG1TEST0001A");
    await expect(deviceIdForSerial("PSG1-TEST-0001-A")).resolves.toMatch(/^[a-f0-9]{64}$/u);
    expect(await deviceIdForSerial("PSG1-TEST-0001-A")).toBe(await deviceIdForSerial("psg1_test 0001_a"));
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
});
