import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { BETA_PROMO_CODE, DEVELOPMENT_FIXTURE_COMPATIBILITY, DEVELOPMENT_FIXTURE_DEVICE_ID, LICENSE_PRICE_USDC, TREASURY_WALLET, USDC_AMOUNT_BASE_UNITS, browserProofMessage, compatibilityProfileSchema, deviceIdSchema, earlyAccessActivateSchema, entitlementRecoverySchema, firmwareArtifactSchema, isExactDevelopmentFixture, orderCreateSchema, releaseManifestSchema, sessionCreateSchema, sessionProofMessage, webCheckoutWalletChallengeMessage, webInstallerWalletChallengeMessage, webSessionCreateSchema, webSessionProofMessage } from "./index";

describe("public contracts", () => {
  it("accepts a SHA-256 device id", () => {
    expect(deviceIdSchema.parse("a".repeat(64))).toHaveLength(64);
  });

  it("pins the commercial constants", () => {
    expect(BETA_PROMO_CODE).toBe("BICCSDEV");
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
        systemBuildFingerprint: "test", vendorBuildFingerprint: "test",
        systemBuildIncremental: "test", systemBuildType: "user", lineageVersion: "",
        bootloaderUnlocked: false, installationState: "stock_locked",
        usbStable: true, recoveryCapable: true, hostBytesAvailable: 8_000_000_000,
        systemPartitionBytes: 4_000_000_000
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
});
