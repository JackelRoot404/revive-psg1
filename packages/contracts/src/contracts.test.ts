import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { BETA_PROMO_CODE, DEVELOPMENT_FIXTURE_COMPATIBILITY, DEVELOPMENT_FIXTURE_DEVICE_ID, LICENSE_PRICE_USDC, TREASURY_WALLET, USDC_AMOUNT_BASE_UNITS, betaActivateSchema, browserProofMessage, compatibilityProfileSchema, deviceIdSchema, earlyAccessActivateSchema, entitlementRecoverySchema, fastbootResumeSchema, firmwareArtifactSchema, installationJournalEntrySchema, installationStartSchema, installerModeSchema, isExactDevelopmentFixture, isSafeDevelopmentModifiedScan, orderCreateSchema, privateFirmwareArtifactSchema, psg1FlashPlanSchema, publicActivateSchema, publicEvidenceSchema, publicResumeSchema, releaseManifestSchema, sessionCreateSchema, sessionProofMessage, webCheckoutWalletChallengeMessage, webInstallerWalletChallengeMessage, webSessionCreateSchema, webSessionProofMessage } from "./index";

const psg1FlashPlan = {
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
} as const;

describe("public contracts", () => {
  it("accepts a SHA-256 device id", () => {
    expect(deviceIdSchema.parse("a".repeat(64))).toHaveLength(64);
  });

  it("pins the commercial constants", () => {
    expect(BETA_PROMO_CODE).toBe("DISCORD_BROWSER_BETA");
    expect(LICENSE_PRICE_USDC).toBe("19.000000");
    expect(USDC_AMOUNT_BASE_UNITS).toBe(19_000_000n);
    expect(TREASURY_WALLET).toBe("EAjkNpwau3hB58C2M4U8rQWFANHRidA8XiB4Dvq78T4y");
  });

  it("does not accept the beta program label as a public coupon", () => {
    const legacy = orderCreateSchema.parse({ sessionId: "00000000-0000-4000-8000-000000000000", promoCode: BETA_PROMO_CODE });
    expect(legacy).not.toHaveProperty("promoCode");
    expect(() => orderCreateSchema.parse({ sessionId: "00000000-0000-4000-8000-000000000000", betaInviteToken: BETA_PROMO_CODE })).toThrow();
  });

  it("requires a concrete device session for free Early Access activation", () => {
    expect(earlyAccessActivateSchema.parse({ sessionId: "00000000-0000-4000-8000-000000000000" }).sessionId).toMatch(/^00000000/);
    expect(() => earlyAccessActivateSchema.parse({})).toThrow();
  });

  it("models the public free activation and server installer modes explicitly", () => {
    expect(publicActivateSchema.parse({ sessionId: "00000000-0000-4000-8000-000000000000" }).sessionId).toMatch(/^00000000/);
    expect(publicResumeSchema.parse({ sessionId: "00000000-0000-4000-8000-000000000000" }).sessionId).toMatch(/^00000000/);
    expect(fastbootResumeSchema.parse({ deviceId: "a".repeat(64), resumeCredential: `rpi_${"b".repeat(32)}` }).resumeCredential).toMatch(/^rpi_/);
    expect(() => publicActivateSchema.parse({})).toThrow();
    expect(installerModeSchema.parse("public")).toBe("public");
    expect(() => installerModeSchema.parse("open")).toThrow();
  });

  it("accepts only the signed PSG1 flash plan", () => {
    expect(psg1FlashPlanSchema.parse(psg1FlashPlan).systemMode).toBe("fastbootd");
    expect(() => psg1FlashPlanSchema.parse({ ...psg1FlashPlan, wipeUserData: false })).toThrow();
    expect(() => psg1FlashPlanSchema.parse({ ...psg1FlashPlan, unlockCommand: "fastboot flashing unlock" })).toThrow();
    expect(() => psg1FlashPlanSchema.parse({ ...psg1FlashPlan, minimumSystemBytes: 1_000_000_000 })).toThrow();
  });

  it("does not allow a signed manifest to relabel an APK as a Fastboot system image", () => {
    const mislabeled = {
      id: "wrong-system", kind: "apk", delivery: "private", component: "android_system", objectKey: "private/releases/test/wrong.apk",
      size: 1, sha256: "a".repeat(64), signerSha256: "b".repeat(64), packageName: "com.example.wrong", versionName: "1"
    };
    expect(privateFirmwareArtifactSchema.safeParse(mislabeled).success).toBe(false);
    expect(privateFirmwareArtifactSchema.safeParse({ ...mislabeled, kind: "system", objectKey: "../outside.img" }).success).toBe(false);
  });

  it("requires completed stock-device browser validation for a public release", () => {
    const evidence = {
      source: {
        releaseUrl: "https://example.com/release", tag: "v1", upstreamAssetName: "system.img",
        upstreamArchiveSha256: "a".repeat(64), expandedSystemSha256: "b".repeat(64)
      },
      licenseReview: {
        status: "approved" as const, license: "Apache-2.0", reviewer: "reviewer",
        reviewedAt: "2026-01-01T00:00:00.000Z", evidenceUrl: "https://example.com/license"
      },
      noGmsInspection: {
        tool: "test", inspectedAt: "2026-01-01T00:00:00.000Z",
        checkedPaths: ["/system/app", "/system/priv-app", "/product/app"], detectedGmsPackages: [],
        reviewedNonGmsGooglePackages: [], reportSha256: "c".repeat(64)
      },
      windowsFastbootDriver: {
        packageUrl: "https://example.com/psg1-driver.msi", installerSha256: "d".repeat(64),
        catalogSha256: "e".repeat(64), authenticodeSigner: "Revive PSG1", hardwareIds: ["USB\\VID_1234&PID_ABCD&MI_01"],
        interfaceGuid: "00000000-0000-4000-8000-000000000000", testedWindowsVersions: ["windows_10", "windows_11"]
      },
      stockPsg1Validation: {
        status: "passed" as const, validatedAt: "2026-01-01T00:00:00.000Z", stockUnitCount: 1,
        chromeWindows: true as const, edgeWindows: true as const, chromeMacos: true as const, edgeMacos: true as const,
        controls: true as const, wifi: true as const, audio: true as const, storage: true as const,
        auroraStore: true as const, retroArch: true as const, diagnostics: true as const, twoColdBoots: true as const
      },
      artifactSha256: { system: "f".repeat(64) },
      review: {
        status: "approved" as const, reviewer: "reviewer", reviewedAt: "2026-01-01T00:00:00.000Z",
        riskAcknowledgement: "I approve public self-service PSG1 installation only for stock-locked devices using this signed flash plan." as const
      }
    };
    expect(publicEvidenceSchema.parse(evidence).stockPsg1Validation.status).toBe("passed");
    const { stockPsg1Validation: _validation, ...withoutValidation } = evidence;
    expect(publicEvidenceSchema.safeParse(withoutValidation).success).toBe(false);
  });

  it("requires an explicit beta code and irreversible acknowledgement", () => {
    expect(betaActivateSchema.parse({ sessionId: "00000000-0000-4000-8000-000000000000", betaInviteToken: `rpb_${"a".repeat(32)}` }).betaInviteToken).toMatch(/^rpb_/);
    expect(() => installationStartSchema.parse({ termsVersion: "beta-1", irreversibleRiskAcknowledged: true, confirmation: "erase" })).toThrow();
    const start = installationStartSchema.parse({
      termsVersion: "public-1", irreversibleRiskAcknowledged: true, confirmation: "ERASE PSG1",
      profileId: "universal-stock-psg1-v1", releaseId: "00000000-0000-4000-8000-000000000000", releaseVersion: "2026.07.30",
      manifestSha256: "b".repeat(64),
      artifactHashes: { system: "a".repeat(64) }
    });
    expect(start.confirmation).toBe("ERASE PSG1");
    expect(installationJournalEntrySchema.parse({
      profileId: start.profileId, releaseVersion: start.releaseVersion, artifactHashes: start.artifactHashes,
      stage: "awaiting_fastbootd_system", operation: "flash_system", operationState: "sent",
      operationIndex: 0, operationCount: 1
    }).operationState).toBe("sent");
    expect(() => installationJournalEntrySchema.parse({
      profileId: start.profileId, releaseVersion: start.releaseVersion, artifactHashes: start.artifactHashes,
      stage: "awaiting_fastbootd_system", operation: "flash_system", operationState: "finished",
      operationIndex: 0, operationCount: 1
    })).toThrow();
  });

  it("requires prefixed high-entropy beta and recovery credentials", () => {
    expect(orderCreateSchema.parse({ sessionId: "00000000-0000-4000-8000-000000000000", betaInviteToken: `rpb_${"a".repeat(32)}` }).betaInviteToken).toMatch(/^rpb_/);
    expect(entitlementRecoverySchema.parse({ recoveryCredential: `rpr_${"b".repeat(32)}` }).recoveryCredential).toMatch(/^rpr_/);
  });

  it("rejects a generic unlock command", () => {
    expect(() => compatibilityProfileSchema.parse({ unlockCommand: "fastboot flashing unlock" })).toThrow();
  });

  it("requires the actual Android API level in a compatibility scan", () => {
    const result = sessionCreateSchema.safeParse({ compatibility: { vendorApiLevel: 35 } });
    expect(result.success).toBe(false);
  });

  it("binds local browser proof to a nonce and ephemeral desktop key", () => {
    const message = browserProofMessage({
      domain: "revivepsg.com", challengeId: "challenge", sessionId: "session", deviceId: "d".repeat(64),
      pairingPublicKey: "pairing", browserNonceHash: "b".repeat(64), nonce: "nonce", expiresAt: "2026-01-01T00:00:00.000Z"
    });
    expect(message).toContain("desktop-key:pairing");
    expect(message).toContain("nonce:nonce");
    expect(message).toContain(`browser-nonce-hash:${"b".repeat(64)}`);
  });

  it("binds initial desktop pairing to a fresh timestamped request", () => {
    const message = sessionProofMessage({
      deviceId: "d".repeat(64), pairingPublicKey: "pairing", appVersion: "1.0.0",
      requestNonce: "n".repeat(32), createdAt: "2026-01-01T00:00:00.000Z"
    });
    expect(message).toContain(`request-nonce:${"n".repeat(32)}`);
    expect(message).toContain("created-at:2026-01-01T00:00:00.000Z");
  });

  it("models web pairing as a separate signed channel", () => {
    const input = {
      deviceId: "d".repeat(64), pairingPublicKey: "11111111111111111111111111111111",
      pairingProof: "a".repeat(64), appVersion: "0.2.0", requestNonce: "n".repeat(32),
      createdAt: "2026-01-01T00:00:00.000Z", hostOs: "web" as const,
      compatibility: {
        product: "PSG1", model: "PSG1", board: "V11", hardware: "RK3588S",
        buildFingerprint: "test", buildIncremental: "test", androidApiLevel: 35,
        vendorApiLevel: 35, batteryPercent: 100, charging: true, serialVerified: true,
        immutableSerialVerified: true,
        fastbootUsbDescriptorVerified: true,
        systemBuildFingerprint: "test", vendorBuildFingerprint: "test",
        systemBuildIncremental: "test", systemBuildType: "user", lineageVersion: "",
        bootloaderUnlocked: false, installationState: "stock_locked",
        usbStable: true, recoveryCapable: true, hostBytesAvailable: 8_000_000_000,
        systemPartitionBytes: 4_000_000_000,
        superPartitionBytes: 54_975_528_960
      }
    };
    expect(webSessionCreateSchema.parse(input).hostOs).toBe("web");
    expect(sessionCreateSchema.safeParse(input).success).toBe(false);
    expect(webSessionProofMessage(input)).toContain("Revive PSG1 web pairing");
  });

  it("recognizes only the exact deterministic development fixture", () => {
    expect(isExactDevelopmentFixture(DEVELOPMENT_FIXTURE_DEVICE_ID, DEVELOPMENT_FIXTURE_COMPATIBILITY)).toBe(true);
    expect(isExactDevelopmentFixture("0".repeat(64), DEVELOPMENT_FIXTURE_COMPATIBILITY)).toBe(false);
    expect(isExactDevelopmentFixture(DEVELOPMENT_FIXTURE_DEVICE_ID, { ...DEVELOPMENT_FIXTURE_COMPATIBILITY, batteryPercent: 84 })).toBe(false);
  });

  it("allows only a verified unlocked Lineage PSG1 into the development diagnostics lane", () => {
    const modified = {
      ...DEVELOPMENT_FIXTURE_COMPATIBILITY,
      installationState: "already_modified" as const,
      bootloaderUnlocked: true,
      lineageVersion: "22.2-UNOFFICIAL"
    };
    expect(isSafeDevelopmentModifiedScan(modified)).toBe(true);
    expect(isSafeDevelopmentModifiedScan({ ...modified, immutableSerialVerified: false as never })).toBe(false);
  });

  it("purpose-binds web installer authorization to the paid order and active license", () => {
    const message = webInstallerWalletChallengeMessage({
      domain: "revivepsg.com", challengeId: "challenge", sessionId: "session", deviceId: "d".repeat(64),
      orderId: "order", licenseId: "license", wallet: TREASURY_WALLET, nonce: "nonce", expiresAt: "2026-01-01T00:00:00.000Z"
    });
    expect(message).toContain("purpose:web-installer");
    expect(message).toContain("order:order");
    expect(message).toContain("license:license");
    expect(message).not.toBe(browserProofMessage({
      domain: "revivepsg.com", challengeId: "challenge", sessionId: "session", deviceId: "d".repeat(64),
      pairingPublicKey: "pairing", browserNonceHash: "b".repeat(64), nonce: "nonce", expiresAt: "2026-01-01T00:00:00.000Z"
    }));
  });

  it("identifies web checkout authorization without claiming a desktop pairing", () => {
    const message = webCheckoutWalletChallengeMessage({
      domain: "revivepsg.com", challengeId: "challenge", sessionId: "session", deviceId: "d".repeat(64),
      pairingPublicKey: "pairing", wallet: TREASURY_WALLET, nonce: "nonce", expiresAt: "2026-01-01T00:00:00.000Z"
    });
    expect(message).toContain("channel:web");
    expect(message).toContain("web-pairing-key:pairing");
    expect(message).not.toContain("desktop-key:");
  });

  it("models Google components only as pinned customer-supplied input", () => {
    const artifact = firmwareArtifactSchema.parse({
      id: "play-lineage-system", kind: "system", delivery: "customer_supplied", component: "google_mobile_services",
      size: 123, sha256: "a".repeat(64),
      source: {
        label: "Customer-provided Google archive", instructionsUrl: "https://revivepsg.com/docs/google-components",
        archiveFilenamePatterns: ["gapps-*.zip"], archiveSize: 456, archiveSha256: "b".repeat(64), extractedPath: "Core/base.apk"
      }
    });
    expect(artifact.delivery).toBe("customer_supplied");
    expect("objectKey" in artifact).toBe(false);
  });

  it("rejects customer-supplied Google APKs because the approved input is the complete system image", () => {
    expect(() => firmwareArtifactSchema.parse({
      id: "gms-base", kind: "apk", delivery: "customer_supplied", component: "google_mobile_services",
      size: 123, sha256: "a".repeat(64),
      source: {
        label: "GMS", instructionsUrl: "https://revivepsg.com/docs/google-components",
        archiveFilenamePatterns: ["*.zip"], archiveSize: 456, archiveSha256: "b".repeat(64), extractedPath: "base.apk"
      }
    })).toThrow();
  });

  it("rejects archive traversal paths for customer-supplied components", () => {
    expect(() => firmwareArtifactSchema.parse({
      id: "play-lineage-system", kind: "system", delivery: "customer_supplied", component: "google_mobile_services",
      size: 123, sha256: "a".repeat(64),
      source: {
        label: "GMS", instructionsUrl: "https://revivepsg.com/docs/google-components", archiveFilenamePatterns: ["*.zip"],
        archiveSize: 456, archiveSha256: "b".repeat(64), extractedPath: "../base.apk"
      }
    })).toThrow();
  });

  it("builds a manifest envelope that validates with private and customer-supplied artifacts", () => {
    const directory = mkdtempSync(resolve(tmpdir(), "revive-release-"));
    const system = resolve(directory, "system.img");
    const archive = resolve(directory, "system.img.xz");
    const vbmeta = resolve(directory, "vbmeta.img");
    writeFileSync(system, "synthetic-system-image");
    writeFileSync(archive, "synthetic-owner-archive");
    writeFileSync(vbmeta, "synthetic-vbmeta");
    const inputPath = resolve(directory, "release.json");
    writeFileSync(inputPath, JSON.stringify({
      releaseId: "00000000-0000-4000-8000-000000000000", version: "test", minimumInstallerVersion: "0.1.0",
      profileIds: ["profile"], releaseNotes: "test", publishedAt: "2026-01-01T00:00:00.000Z", signingKeyId: "test-key",
      flashPlan: psg1FlashPlan,
      artifacts: [
        { id: "system", kind: "system", delivery: "customer_supplied", component: "google_mobile_services", path: system, archivePath: archive,
          source: { label: "Owner image", instructionsUrl: "https://example.com/image", archiveFilenamePatterns: ["*.xz"], extractedPath: "system.img" } },
        { id: "vbmeta", kind: "vbmeta", delivery: "private", component: "verified_boot", path: vbmeta, objectKey: "private/vbmeta.img" }
      ]
    }));
    const builder = resolve(process.cwd(), "../../tools/build-release-manifest.mjs");
    const document = JSON.parse(execFileSync(process.execPath, [builder, inputPath], { encoding: "utf8" }));
    expect(releaseManifestSchema.parse({ ...document, signature: "a".repeat(64) }).artifacts).toHaveLength(2);
    expect(document.artifacts.find((artifact: { id: string }) => artifact.id === "system")).not.toHaveProperty("objectKey");
  });

  it("refuses a private Android-system manifest without release evidence", () => {
    const directory = mkdtempSync(resolve(tmpdir(), "revive-beta-evidence-"));
    const system = resolve(directory, "system.img");
    const vbmeta = resolve(directory, "vbmeta.img");
    const diagnostics = resolve(directory, "diagnostics.apk");
    const diagnosticsTest = resolve(directory, "diagnostics-test.apk");
    const aurora = resolve(directory, "aurora.apk");
    const retroarch = resolve(directory, "retroarch.apk");
    writeFileSync(system, "synthetic-private-system-image");
    writeFileSync(vbmeta, "synthetic-vbmeta");
    writeFileSync(diagnostics, "synthetic-diagnostics");
    writeFileSync(diagnosticsTest, "synthetic-diagnostics-test");
    writeFileSync(aurora, "synthetic-aurora");
    writeFileSync(retroarch, "synthetic-retroarch");
    const inputPath = resolve(directory, "release.json");
    writeFileSync(inputPath, JSON.stringify({
      releaseId: "00000000-0000-4000-8000-000000000000", version: "test", minimumInstallerVersion: "0.1.0",
      profileIds: ["profile"], releaseNotes: "test", publishedAt: "2026-01-01T00:00:00.000Z", signingKeyId: "test-key",
      flashPlan: psg1FlashPlan,
      artifacts: [
        { id: "system", kind: "system", delivery: "private", component: "android_system", path: system, objectKey: "private/system.img" },
        { id: "vbmeta", kind: "vbmeta", delivery: "private", component: "verified_boot", path: vbmeta, objectKey: "private/vbmeta.img" },
        { id: "diagnostics", kind: "apk", delivery: "private", component: "diagnostics", path: diagnostics, objectKey: "private/diagnostics.apk", packageName: "com.revivepsg1.diagnostics", versionName: "1.0.0", signerSha256: "c".repeat(64) },
        { id: "diagnostics-test", kind: "apk", delivery: "private", component: "diagnostics_test", path: diagnosticsTest, objectKey: "private/diagnostics-test.apk", packageName: "com.revivepsg1.diagnostics.test", signerSha256: "d".repeat(64) },
        { id: "aurora", kind: "apk", delivery: "private", component: "aurora_store", path: aurora, objectKey: "private/aurora.apk", packageName: "com.aurora.store", versionName: "1.0.0", signerSha256: "e".repeat(64) },
        { id: "retroarch", kind: "apk", delivery: "private", component: "retroarch", path: retroarch, objectKey: "private/retroarch.apk", packageName: "com.retroarch", versionName: "1.0.0", signerSha256: "f".repeat(64) }
      ]
    }));
    const builder = resolve(process.cwd(), "../../tools/build-release-manifest.mjs");
    expect(() => execFileSync(process.execPath, [builder, inputPath], { encoding: "utf8" })).toThrow(/publicEvidencePath or betaEvidencePath/);
  });
});
