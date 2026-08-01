import { describe, expect, it } from "vitest";
import type { WebCompatibilityScan } from "../../lib/webusb-psg1";
import { buildRedactedCompatibilityReport, canAttemptPublicResume, canOfferCompatibilityReport, installerVersionSatisfies, matchingJournalStep, scanOutcome } from "./wizard";

const scan = {
  deviceId: "a".repeat(64),
  bootloaderSerial: "PS21-PRIVATE-BOOTLOADER-1234",
  product: "PSG1",
  model: "PSG1",
  board: "RK3588S VID=2207 PID=0011 idVendor=0x2207 idProduct=0x0011 USB\\VID_2207&PID_0011",
  hardware: "rk3588",
  buildFingerprint: "vendor/PSG1:15/build:user/release-keys serial=TOP_SECRET",
  buildIncremental: "unknown-build",
  systemBuildFingerprint: "vendor/PSG1:15/build:user/release-keys",
  vendorBuildFingerprint: "vendor/PSG1:15/build:user/release-keys",
  systemBuildIncremental: "unknown-build",
  systemBuildType: "user",
  lineageVersion: "",
  bootloaderUnlocked: false,
  installationState: "stock_locked",
  androidApiLevel: 35,
  vendorApiLevel: 35,
  batteryPercent: 82,
  charging: true,
  serialVerified: true,
  immutableSerialVerified: true,
  fastbootUsbDescriptorVerified: true,
  usbStable: true,
  recoveryCapable: true,
  hostBytesAvailable: 64_000_000_000,
  systemPartitionBytes: 4_000_000_000,
  superPartitionBytes: 54_975_528_960
} satisfies WebCompatibilityScan;

describe("optional compatibility report", () => {
  it("only includes whitelisted, redacted build data", () => {
    const report = buildRedactedCompatibilityReport(scan);

    expect(Object.keys(report)).toEqual([
      "reportVersion", "product", "model", "board", "hardware", "buildFingerprint", "buildIncremental",
      "systemBuildFingerprint", "vendorBuildFingerprint", "systemBuildIncremental", "systemBuildType",
      "androidApiLevel", "vendorApiLevel"
    ]);
    expect(JSON.stringify(report)).not.toContain(scan.deviceId);
    expect(JSON.stringify(report)).not.toContain(scan.bootloaderSerial);
    expect(JSON.stringify(report)).not.toContain("TOP_SECRET");
    expect(JSON.stringify(report)).not.toContain("2207");
    expect(JSON.stringify(report)).not.toContain("0011");
    expect(report.board).toContain("[redacted-usb-id]");
    expect(report.buildFingerprint).toContain("[redacted]");
  });

  it("offers the action only for a charged, stock-locked unrecognized profile", () => {
    const session = { supported: false } as Parameters<typeof canOfferCompatibilityReport>[0];
    const decision = {
      profile: "not_recognized",
      preflight: "blocked",
      deviceState: "stock_locked",
      blockers: ["PROFILE_NOT_RECOGNIZED"],
      installerMode: "scan_only",
      canInstall: false
    } as Parameters<typeof canOfferCompatibilityReport>[2];

    expect(canOfferCompatibilityReport(session, scan, decision, "unsupported")).toBe(true);
    expect(canOfferCompatibilityReport(session, { ...scan, batteryPercent: 20, charging: false }, decision, "unsupported")).toBe(false);
    expect(canOfferCompatibilityReport(session, { ...scan, installationState: "stock_unlocked" }, decision, "unsupported")).toBe(false);
    expect(canOfferCompatibilityReport(session, scan, { ...decision, blockers: ["PROFILE_SELECTION_AMBIGUOUS"] }, "unsupported")).toBe(false);
  });
});

describe("public result language", () => {
  it("does not call a compatible PSG1 ineligible when public starts are paused", () => {
    const decision = {
      profile: "matched", preflight: "passed", deviceState: "stock_locked", blockers: ["INSTALLER_NEW_STARTS_PAUSED"],
      installerMode: "public", canInstall: false
    } as Parameters<typeof scanOutcome>[0];
    expect(scanOutcome(decision, scan)).toBe("public_paused");
  });

  it("compares the signed minimum installer version before artifacts are downloaded", () => {
    expect(installerVersionSatisfies("0.3.0-browser", "0.3.0")).toBe(true);
    expect(installerVersionSatisfies("0.2.9-browser", "0.3.0")).toBe(false);
    expect(installerVersionSatisfies("invalid", "0.3.0")).toBe(false);
  });
});

const releaseArtifacts = ([
  "android_system",
  "verified_boot",
  "diagnostics",
  "diagnostics_test",
  "aurora_store",
  "retroarch"
] as const).map((component, index) => ({
  id: `artifact_${index}`,
  size: 1_024 + index,
  sha256: String(index).repeat(64),
  objectKey: `releases/2026.07.31/${component}`,
  kind: component === "android_system" ? "system" as const : component === "verified_boot" ? "vbmeta" as const : "apk" as const,
  component,
  delivery: "private" as const
}));

const resumeRelease = {
  manifest: { version: "2026.07.31", artifacts: releaseArtifacts },
  profile: { id: "universal-stock-psg1-v1" }
} as Parameters<typeof matchingJournalStep>[0];

describe("device-bound public resume", () => {
  it("offers emergency resume even when a boundary-crossed PSG1 still reports stock-locked", () => {
    const session = { browserToken: "browser-checkout-token" } as Parameters<typeof canAttemptPublicResume>[0];
    expect(canAttemptPublicResume(session, scan)).toBe(true);
    expect(canAttemptPublicResume(session, { ...scan, immutableSerialVerified: false } as never)).toBe(false);
  });

  it("starts an exact resume at the safe boundary when no command journal exists yet", async () => {
    await expect(matchingJournalStep(resumeRelease, scan, null, true)).resolves.toEqual({
      step: "start",
      operation: "begin",
      operationState: "unknown",
      operationIndex: 0,
      operationCount: 1
    });
    await expect(matchingJournalStep(resumeRelease, scan, null, false)).resolves.toBeNull();
  });

  it("uses only a matching server checkpoint and rejects a wrong device or artifact map", async () => {
    const journal = {
      deviceId: scan.deviceId,
      profileId: "universal-stock-psg1-v1",
      releaseVersion: "2026.07.31",
      artifactHashes: Object.fromEntries(releaseArtifacts.map((artifact) => [artifact.id, artifact.sha256])),
      stage: "awaiting_fastbootd_system",
      operation: "flash_system",
      operationState: "sent" as const,
      operationIndex: 1,
      operationCount: 3,
      updatedAt: "2026-07-31T00:00:00.000Z"
    };
    await expect(matchingJournalStep(resumeRelease, scan, journal, true)).resolves.toMatchObject({
      step: "awaiting_fastbootd_system",
      operation: "flash_system",
      operationState: "sent",
      operationIndex: 1,
      operationCount: 3
    });
    await expect(matchingJournalStep(resumeRelease, scan, { ...journal, deviceId: "b".repeat(64) }, true)).resolves.toBeNull();
    await expect(matchingJournalStep(resumeRelease, scan, {
      ...journal,
      artifactHashes: { ...journal.artifactHashes, artifact_0: "f".repeat(64) }
    }, true)).resolves.toBeNull();
  });
});
