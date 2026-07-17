import { describe, expect, it } from "vitest";
import type { CompatibilityProfile, CompatibilitySnapshot } from "@revive-psg1/contracts";
import { profileMatches } from "./profiles";

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
