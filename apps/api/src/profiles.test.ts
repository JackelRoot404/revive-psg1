import { describe, expect, it } from "vitest";
import type { CompatibilityProfile, CompatibilitySnapshot, WebCompatibilitySnapshot } from "@revive-psg1/contracts";
import { profileMatches, webPreflightMatches, webProfileMatches } from "./profiles";

const profile: CompatibilityProfile = {
  id: "psg1-rk3588s-v11-api35-v1",
  version: 1,
  product: "PSG1",
  modelPatterns: ["^PSG1$"],
  boardPatterns: ["RK3588S.*V11"],
  hardwarePatterns: ["rk3588"],
  soc: "RK3588S",
  androidApiLevels: [35],
  vendorApiLevels: [35],
  firmwarePatterns: ["playsolana-20260521-145647"],
  partitionConstraints: { system: { minSize: 2_000_000_000, maxSize: 4_294_967_296 } },
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
  it("rejects an Android release number accidentally supplied as API level", () => expect(profileMatches(profile, { ...snapshot, androidApiLevel: 15 })).toBe(false));
  it("rejects an unknown incremental build even when the model matches", () => expect(profileMatches(profile, { ...snapshot, buildIncremental: "unknown", buildFingerprint: "unknown" })).toBe(false));
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
    systemPartitionBytes: 4_000_000_000
  };

  it("accepts a fully cross-checked device with adequate host capacity", () => expect(webPreflightMatches(profile, webSnapshot)).toBe(true));
  it("rejects a partition outside the signed profile", () => expect(webPreflightMatches(profile, { ...webSnapshot, systemPartitionBytes: 5_000_000_000 })).toBe(false));
  it("rejects low battery unless the device is charging", () => expect(webPreflightMatches(profile, { ...webSnapshot, batteryPercent: 20, charging: false })).toBe(false));
  it("rejects inadequate browser storage", () => expect(webPreflightMatches(profile, { ...webSnapshot, hostBytesAvailable: 1_000_000_000 })).toBe(false));

  it("matches stock firmware from the actual system identity", () => expect(webProfileMatches(profile, webSnapshot)).toBe(true));
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
