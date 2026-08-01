import { describe, expect, it } from "vitest";
import { normalizeInstallationJournal } from "./artifact-cache";

const journal = {
  deviceId: "a".repeat(64),
  bootloaderSerial: "PSG1SERIAL",
  profileId: "universal-stock-psg1",
  releaseVersion: "1.0.0",
  artifactHashes: { system: "b".repeat(64) },
  stage: "awaiting_fastbootd_system",
  operation: "flash_system",
  operationState: "sent" as const,
  updatedAt: "2026-07-30T00:00:00.000Z"
};

describe("installation journal normalization", () => {
  it("preserves write-ahead operation state", () => {
    expect(normalizeInstallationJournal(journal)).toMatchObject({ operation: "flash_system", operationState: "sent" });
  });

  it("treats legacy journals as indeterminate rather than verified", () => {
    const { operation: _operation, operationState: _operationState, ...legacy } = journal;
    expect(normalizeInstallationJournal(legacy)).toMatchObject({ operation: "legacy_resume", operationState: "unknown" });
  });

  it("rejects an incomplete journal", () => {
    expect(normalizeInstallationJournal({ ...journal, profileId: "" })).toBeNull();
  });
});
