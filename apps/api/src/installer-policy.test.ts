import { describe, expect, it } from "vitest";
import type { CompatibilityProfile, InstallationJournalEntry, WebCompatibilitySnapshot } from "@revive-psg1/contracts";
import { buildWebSessionDecision, canonicalSignedDocumentSha256, installerVersionSatisfies, selectUniqueReleaseForProfile, validateInstallationJournalTransition } from "./app";
import type { ProfileSelection } from "./profiles";

const profile: CompatibilityProfile = {
  id: "universal-stock-psg1-v1",
  version: 1,
  priority: 10,
  product: "PSG1",
  modelPatterns: ["^PSG1$"],
  boardPatterns: ["RK3588S"],
  hardwarePatterns: ["rk3588"],
  soc: "RK3588S",
  androidApiLevels: [35],
  vendorApiLevels: [35],
  firmwarePatterns: ["^PlaySolana/PSG1/PSG1:"],
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

const snapshot: WebCompatibilitySnapshot = {
  product: "PSG1",
  model: "PSG1",
  board: "RK3588S PSG1 V11",
  hardware: "rk3588",
  buildFingerprint: "PlaySolana/PSG1/PSG1:15/build:user/release-keys",
  buildIncremental: "build",
  systemBuildFingerprint: "PlaySolana/PSG1/PSG1:15/build:user/release-keys",
  vendorBuildFingerprint: "PlaySolana/PSG1/PSG1:15/build:user/release-keys",
  systemBuildIncremental: "build",
  systemBuildType: "user",
  lineageVersion: "",
  bootloaderUnlocked: false,
  installationState: "stock_locked",
  androidApiLevel: 35,
  vendorApiLevel: 35,
  batteryPercent: 80,
  charging: true,
  serialVerified: true,
  immutableSerialVerified: true,
  fastbootUsbDescriptorVerified: true,
  usbStable: true,
  recoveryCapable: true,
  hostBytesAvailable: 8_000_000_000,
  systemPartitionBytes: 4_000_000_000,
  superPartitionBytes: 54_000_000_000
};

const matched: ProfileSelection = { status: "matched", profile };

function journalEntry(overrides: Partial<InstallationJournalEntry> = {}): InstallationJournalEntry {
  return {
    profileId: "universal-stock-psg1-v1",
    releaseVersion: "2026.07.31",
    artifactHashes: { system: "a".repeat(64) },
    stage: "start",
    operation: "begin",
    operationState: "intent",
    operationIndex: 0,
    operationCount: 1,
    ...overrides
  };
}

describe("web installer decision", () => {
  it("refuses a stale browser protocol before public artifact access", () => {
    expect(installerVersionSatisfies("0.3.0-browser", "0.3.0-browser")).toBe(true);
    expect(installerVersionSatisfies("0.4.0-browser", "0.3.9")).toBe(true);
    expect(installerVersionSatisfies("0.2.9-browser", "0.3.0")).toBe(false);
    expect(installerVersionSatisfies("not-a-version", "0.3.0")).toBe(false);
  });

  it("uses the signed-document canonical digest rather than object insertion order", () => {
    const document = { z: [3, { b: "x", a: true }], a: { nested: "✓", count: 2 } };
    const reordered = { a: { count: 2, nested: "✓" }, z: [3, { a: true, b: "x" }] };
    expect(canonicalSignedDocumentSha256(document)).toBe("260637f7b07bd42cfeba494fa85936a22418da91bb12e4edad745c90d31f1d56");
    expect(canonicalSignedDocumentSha256(reordered)).toBe(canonicalSignedDocumentSha256(document));
    expect(canonicalSignedDocumentSha256({ ...reordered, z: [4] })).not.toBe(canonicalSignedDocumentSha256(document));
  });

  it("selects exactly one active signed release for the scanned profile and rejects absent or ambiguous bindings", () => {
    const universal = { name: "universal", manifest: { profileIds: ["universal-stock-psg1-v1"] } };
    const variant = { name: "variant", manifest: { profileIds: ["psg1-rk3588s-v11-api35-v1"] } };
    expect(selectUniqueReleaseForProfile([universal, variant], "universal-stock-psg1-v1")).toBe(universal);
    expect(selectUniqueReleaseForProfile([universal, variant], "missing-profile")).toBeNull();
    expect(selectUniqueReleaseForProfile([universal, { ...universal, name: "duplicate" }], "universal-stock-psg1-v1")).toBeNull();
  });

  it("makes public installation available only after every independent gate passes", () => {
    expect(buildWebSessionDecision({
      selection: matched,
      snapshot,
      installerMode: "public",
      preflightBlockers: [],
      developmentRecognized: false,
      publicReleaseReady: true,
      installerNewStartsEnabled: true
    })).toEqual({
      profile: "matched",
      deviceState: "stock_locked",
      preflight: "passed",
      blockers: [],
      installerMode: "public",
      canInstall: true
    });
  });

  it("keeps a compatible private-beta device behind its invite entitlement", () => {
    const decision = buildWebSessionDecision({
      selection: matched,
      snapshot,
      installerMode: "private_beta",
      preflightBlockers: [],
      developmentRecognized: false,
      publicReleaseReady: false,
      installerNewStartsEnabled: true
    });
    expect(decision.canInstall).toBe(false);
    expect(decision.blockers).toContain("PRIVATE_BETA_INVITE_REQUIRED");
  });

  it("reports a priority tie as not recognized and never chooses a profile", () => {
    const decision = buildWebSessionDecision({
      selection: { status: "ambiguous", priority: 10, profileIds: ["a", "b"] },
      snapshot,
      installerMode: "public",
      preflightBlockers: [],
      developmentRecognized: false,
      publicReleaseReady: true,
      installerNewStartsEnabled: true
    });
    expect(decision.profile).toBe("not_recognized");
    expect(decision.preflight).toBe("blocked");
    expect(decision.blockers).toContain("PROFILE_SELECTION_AMBIGUOUS");
    expect(decision.canInstall).toBe(false);
  });

  it("separates a recognized preflight pass from an unsafe device state", () => {
    const decision = buildWebSessionDecision({
      selection: matched,
      snapshot: { ...snapshot, installationState: "stock_unlocked", bootloaderUnlocked: true },
      installerMode: "public",
      preflightBlockers: [],
      developmentRecognized: false,
      publicReleaseReady: true,
      installerNewStartsEnabled: true
    });
    expect(decision.profile).toBe("matched");
    expect(decision.preflight).toBe("passed");
    expect(decision.blockers).toContain("DEVICE_STATE_STOCK_UNLOCKED");
    expect(decision.canInstall).toBe(false);
  });

  it("keeps a public stock-locked match non-destructive while the new-start kill switch is active", () => {
    const decision = buildWebSessionDecision({
      selection: matched,
      snapshot,
      installerMode: "public",
      preflightBlockers: [],
      developmentRecognized: false,
      publicReleaseReady: true,
      installerNewStartsEnabled: false
    });
    expect(decision.canInstall).toBe(false);
    expect(decision.blockers).toContain("INSTALLER_NEW_STARTS_PAUSED");
  });
});

describe("installation journal state machine", () => {
  it("accepts the exact write-ahead sequence and refuses an unresolved jump", () => {
    const beginIntent = journalEntry();
    const beginSent = journalEntry({ stage: "awaiting_bootloader_unlock", operationState: "sent" });
    const beginVerified = journalEntry({ stage: "awaiting_bootloader_unlock", operationState: "verified" });
    const unlockIntent = journalEntry({
      stage: "awaiting_bootloader_unlock",
      operation: "unlock",
      operationState: "intent"
    });
    const unlockSent = journalEntry({
      stage: "awaiting_unlocked_android",
      operation: "unlock",
      operationState: "sent"
    });
    const unlockVerified = journalEntry({
      stage: "awaiting_unlocked_android",
      operation: "unlock",
      operationState: "verified"
    });
    const rebootForVbmetaIntent = journalEntry({
      stage: "awaiting_unlocked_android",
      operation: "reboot_for_vbmeta",
      operationState: "intent"
    });

    expect(validateInstallationJournalTransition(null, beginIntent)).toBeNull();
    expect(validateInstallationJournalTransition(beginIntent, beginSent)).toBeNull();
    expect(validateInstallationJournalTransition(beginSent, beginVerified)).toBeNull();
    expect(validateInstallationJournalTransition(beginVerified, unlockIntent)).toBeNull();
    expect(validateInstallationJournalTransition(unlockIntent, unlockSent)).toBeNull();
    expect(validateInstallationJournalTransition(unlockSent, unlockVerified)).toBeNull();
    expect(validateInstallationJournalTransition(unlockVerified, rebootForVbmetaIntent)).toBeNull();

    expect(validateInstallationJournalTransition(beginSent, unlockIntent))
      .toMatch(/unresolved/u);
    expect(validateInstallationJournalTransition(null, unlockIntent))
      .toMatch(/must begin/u);
  });

  it("permits only ordered, idempotent sparse system segments", () => {
    const resizeVerified = journalEntry({
      stage: "awaiting_fastbootd_system",
      operation: "resize_system",
      operationState: "verified"
    });
    const segment0Intent = journalEntry({
      stage: "awaiting_fastbootd_system",
      operation: "flash_system",
      operationState: "intent",
      operationIndex: 0,
      operationCount: 3
    });
    const segment0Sent = journalEntry({ ...segment0Intent, operationState: "sent" });
    const segment0Verified = journalEntry({ ...segment0Intent, operationState: "verified" });
    const segment1Intent = journalEntry({ ...segment0Intent, operationIndex: 1, operationState: "intent" });
    const segment1Verified = journalEntry({ ...segment1Intent, operationState: "verified" });
    const segment2Intent = journalEntry({ ...segment0Intent, operationIndex: 2, operationState: "intent" });

    expect(validateInstallationJournalTransition(resizeVerified, segment0Intent)).toBeNull();
    expect(validateInstallationJournalTransition(segment0Intent, segment0Sent)).toBeNull();
    expect(validateInstallationJournalTransition(segment0Sent, segment0Verified)).toBeNull();
    expect(validateInstallationJournalTransition(segment0Verified, segment1Intent)).toBeNull();
    expect(validateInstallationJournalTransition(segment1Verified, segment2Intent)).toBeNull();
    expect(validateInstallationJournalTransition(segment0Verified, segment2Intent))
      .toMatch(/exact signed order/u);
    expect(validateInstallationJournalTransition(resizeVerified, journalEntry({
      stage: "awaiting_fastbootd_system",
      operation: "flash_system",
      operationState: "intent",
      operationIndex: 1,
      operationCount: 3
    }))).toMatch(/start at segment zero/u);
  });

  it("does not retry an uncertain unlock, but can retry an uncertain sparse transfer", () => {
    const unlockSent = journalEntry({
      stage: "awaiting_unlocked_android",
      operation: "unlock",
      operationState: "sent"
    });
    const unlockUnknown = journalEntry({
      stage: "awaiting_unlocked_android",
      operation: "unlock",
      operationState: "unknown"
    });
    const unlockRetry = journalEntry({
      stage: "awaiting_bootloader_unlock",
      operation: "unlock",
      operationState: "intent"
    });
    const sparseUnknown = journalEntry({
      stage: "awaiting_fastbootd_system",
      operation: "flash_system",
      operationState: "unknown",
      operationIndex: 0,
      operationCount: 2
    });
    const sparseRetry = journalEntry({ ...sparseUnknown, operationState: "intent" });

    expect(validateInstallationJournalTransition(unlockSent, unlockUnknown)).toBeNull();
    expect(validateInstallationJournalTransition(unlockUnknown, unlockRetry))
      .toMatch(/retry only an idempotent/u);
    expect(validateInstallationJournalTransition(sparseUnknown, sparseRetry)).toBeNull();
  });
});
