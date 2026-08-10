import { describe, expect, it } from "vitest";
import type { CompatibilityProfile, CompatibilitySnapshot, WebCompatibilitySnapshot } from "@revive-psg1/contracts";
import { profileMatches, selectHighestPriorityProfile, webPreflightBlockers, webPreflightMatches, webProfileMatches } from "./profiles";

const profile: CompatibilityProfile = {
  id: "psg1-rk3588s-v11-api35-v1",
  version: 1,
  priority: 100,
  product: "PSG1",
  modelPatterns: ["^PSG1$"],
  boardPatterns: ["RK3588S.*V11"],
  hardwarePatterns: ["rk3588"],
  soc: "RK3588S",
  androidApiLevels: [35],
  vendorApiLevels: [35],
  firmwarePatterns: ["playsolana-20260521-145647"],
  partitionConstraints: {
    system: { minSize: 2_000_000_000, maxSize: 4_294_967_296 },
    super: { minSize: 50_000_000_000, maxSize: 60_000_000_000 }
  },
  unlockCommand: "fastboot oem at-unlock-vboot",
  requiredArtifacts: [],
  expectedCapabilities: { controls: true, wifi: true, audio: true, fingerprint: false },
  diagnosticsCommand: ["am", "instrument"],
  signature: "x".repeat(64)
};

const snapshot: CompatibilitySnapshot = {
  product: "PSG1",
  model: "PSG1",
  board: "RK3588S PSG1 V11",
  hardware: "rk3588",
  buildFingerprint: "playsolana/PSG1/PSG1:15/release/other:userdebug/test-keys",
  buildIncremental: "playsolana-20260521-145647",
  androidApiLevel: 35,
  vendorApiLevel: 35,
  batteryPercent: 80,
  charging: true
};

describe("fail-closed compatibility matching", () => {
  it("matches the Android API and incremental build explicitly", () => expect(profileMatches(profile, snapshot)).toBe(true));
  it("matches a stock 1.1.23 vector through the universal profile rather than a firmware allowlist", () => {
    const universal: CompatibilityProfile = {
      ...profile,
      id: "universal-stock-psg1-v1",
      priority: 10,
      boardPatterns: ["PSG1"],
      firmwarePatterns: ["^PlaySolana/PSG1/PSG1:"]
    };
    const stock1123 = {
      ...snapshot,
      buildFingerprint: "PlaySolana/PSG1/PSG1:15/1.1.23/user/release-keys",
      buildIncremental: "1.1.23"
    };
    expect(profileMatches(universal, stock1123)).toBe(true);
  });
  it("rejects an Android release number accidentally supplied as API level", () => expect(profileMatches(profile, { ...snapshot, androidApiLevel: 15 })).toBe(false));
  it("rejects an unknown incremental build even when the model matches", () => expect(profileMatches(profile, { ...snapshot, buildIncremental: "unknown", buildFingerprint: "unknown" })).toBe(false));
});

describe("signed profile priority", () => {
  it("selects the unique highest-priority match independently of row order", () => {
    const lower = { ...profile, id: "lower", priority: 10 };
    const higher = { ...profile, id: "higher", priority: 20 };
    const selected = selectHighestPriorityProfile([lower, higher]);
    expect(selected.status).toBe("matched");
    if (selected.status === "matched") expect(selected.profile.id).toBe("higher");
  });

  it("rejects a highest-priority tie instead of choosing a database row order", () => {
    const selected = selectHighestPriorityProfile([
      { ...profile, id: "z-profile", priority: 20 },
      { ...profile, id: "a-profile", priority: 20 },
      { ...profile, id: "lower", priority: 10 }
    ]);
    expect(selected).toEqual({ status: "ambiguous", priority: 20, profileIds: ["a-profile", "z-profile"] });
  });
});

describe("web destructive preflight", () => {
  const webSnapshot: WebCompatibilitySnapshot = {
    ...snapshot,
    systemBuildFingerprint: snapshot.buildFingerprint,
    vendorBuildFingerprint: snapshot.buildFingerprint,
    systemBuildIncremental: snapshot.buildIncremental,
    systemBuildType: "user",
    lineageVersion: "",
    bootloaderUnlocked: false,
    installationState: "stock_locked",
    serialVerified: true,
    immutableSerialVerified: true,
    fastbootUsbDescriptorVerified: true,
    usbStable: true,
    recoveryCapable: true,
    hostBytesAvailable: 8_000_000_000,
    systemPartitionBytes: 4_000_000_000,
    superPartitionBytes: 54_975_528_960
  };

  it("accepts a fully cross-checked device with adequate host capacity", () => expect(webPreflightMatches(profile, webSnapshot)).toBe(true));
  it("rejects a partition outside the signed profile", () => expect(webPreflightMatches(profile, { ...webSnapshot, systemPartitionBytes: 5_000_000_000 })).toBe(false));
  it("rejects a super partition outside the signed profile", () => expect(webPreflightMatches(profile, { ...webSnapshot, superPartitionBytes: 49_000_000_000 })).toBe(false));
  it("rejects low battery unless the device is charging", () => expect(webPreflightMatches(profile, { ...webSnapshot, batteryPercent: 20, charging: false })).toBe(false));
  it("rejects inadequate browser storage", () => expect(webPreflightMatches(profile, { ...webSnapshot, hostBytesAvailable: 1_000_000_000 })).toBe(false));
  it("treats an absent USB descriptor serial as advisory when immutable identity is verified", () => {
    expect(webPreflightMatches(profile, { ...webSnapshot, fastbootUsbDescriptorVerified: false })).toBe(true);
  });
  it("returns structured preflight blockers without collapsing compatibility state", () => {
    expect(webPreflightBlockers(profile, { ...webSnapshot, batteryPercent: 20, charging: false })).toContain("BATTERY_OR_CHARGING_REQUIRED");
  });

  it("matches stock firmware from the actual system identity", () => expect(webProfileMatches(profile, webSnapshot)).toBe(true));
  it("rejects a userdebug stock marker from the destructive stock lane", () => expect(webProfileMatches(profile, {
    ...webSnapshot,
    systemBuildType: "userdebug"
  })).toBe(false));
  it("does not mistake a Lineage system for stock when merged props retain PlaySolana", () => expect(webProfileMatches(profile, {
    ...webSnapshot,
    systemBuildFingerprint: "generic/lineage_gsi_arm64_gN/lineage_gsi_arm64:15/build:userdebug/release-keys",
    systemBuildIncremental: "1750492249",
    lineageVersion: "22.2-UNOFFICIAL",
    bootloaderUnlocked: true,
    installationState: "stock_unlocked"
  })).toBe(false));
  it("accepts the same device only in the explicit already-modified lane", () => expect(webProfileMatches(profile, {
    ...webSnapshot,
    systemBuildFingerprint: "generic/lineage_gsi_arm64_gN/lineage_gsi_arm64:15/build:userdebug/release-keys",
    vendorBuildFingerprint: "PlaySolana/PSG1/PSG1:15/build/playsolana-20260521-145647:user/release-keys",
    systemBuildIncremental: "1750492249",
    lineageVersion: "22.2-UNOFFICIAL",
    bootloaderUnlocked: true,
    installationState: "already_modified"
  })).toBe(true));
});
