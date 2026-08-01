import { describe, expect, it } from "vitest";
import { safeEqualHex, TokenService, sha256 } from "./security";
import type { Config } from "./config";

const config: Config = {
  nodeEnv: "test", port: 8080, publicApiUrl: "http://localhost:8080", publicWebUrl: "http://localhost:3000",
  allowedOrigins: ["http://localhost:3000"], databaseUrl: "postgres://unused", sessionTokenSecret: "x".repeat(32),
  licenseKeyId: "test", solanaRpcPrimary: "http://localhost:8899",
  treasuryWallet: "EAjkNpwau3hB58C2M4U8rQWFANHRidA8XiB4Dvq78T4y", spacesRegion: "nyc3", spacesBucket: "test",
  crashReportsEnabled: true, earlyAccessFree: true, developmentHardwareFixture: false, publicSalesEnabled: false,
  installerMode: "scan_only",
  installerNewStartsEnabled: true,
  compatibilityCheckerOnly: true, betaBrowserInstaller: false, betaHardwarePilotEnabled: false
};

describe("TokenService", () => {
  it("keeps a license bound to its device while retaining receipt wallet", async () => {
    const service = new TokenService(config);
    const token = await service.issueLicenseToken({ licenseId: "license-1", deviceId: "d".repeat(64), wallet: "EAjkNpwau3hB58C2M4U8rQWFANHRidA8XiB4Dvq78T4y" });
    const claim = await service.verifyLicenseToken(token);
    expect(claim.deviceId).toBe("d".repeat(64));
    expect(claim.receiptWallet).toBe(config.treasuryWallet);
    expect(claim.entitlement).toBe("all-releases");
  });
  it("hashes sensitive identifiers deterministically", () => expect(sha256("revive-psg1:v1SERIAL")).toMatch(/^[a-f0-9]{64}$/));
  it("compares persisted secret digests without string timing leakage", () => {
    expect(safeEqualHex(sha256("secret"), sha256("secret"))).toBe(true);
    expect(safeEqualHex(sha256("secret"), sha256("other"))).toBe(false);
    expect(safeEqualHex("invalid", sha256("other"))).toBe(false);
  });
  it("does not accept a copied initial checkout token as browser-bound authorization", async () => {
    const service = new TokenService(config);
    const token = await service.issueSessionToken({ audience: "checkout", subject: "session", sessionId: "session", deviceId: "d".repeat(64) });
    await expect(service.verifySessionToken(token, "browser-checkout")).rejects.toThrow();
  });

  it("keeps web installer tokens isolated from checkout and wallet authorization", async () => {
    const service = new TokenService(config);
    const token = await service.issueSessionToken({
      audience: "web-installer", subject: "00000000-0000-4000-8000-000000000001",
      sessionId: "00000000-0000-4000-8000-000000000002", deviceId: "d".repeat(64),
      wallet: config.treasuryWallet, expiresIn: "10m"
    });
    const claim = await service.verifySessionToken(token, "web-installer");
    expect(claim.sub).toBe("00000000-0000-4000-8000-000000000001");
    expect(claim.wallet).toBe(config.treasuryWallet);
    await expect(service.verifySessionToken(token, "browser-checkout")).rejects.toThrow();
    await expect(service.verifySessionToken(token, "wallet")).rejects.toThrow();
  });

  it("does not accept a desktop license token as web installer session authorization", async () => {
    const service = new TokenService(config);
    const token = await service.issueLicenseToken({ licenseId: "license-1", deviceId: "d".repeat(64), wallet: config.treasuryWallet });
    await expect(service.verifySessionToken(token, "web-installer")).rejects.toThrow();
  });

  it("keeps a durable Fastboot-only resume token separate from normal installer sessions", async () => {
    const service = new TokenService(config);
    const token = await service.issueSessionToken({
      audience: "web-installer-resume", subject: "00000000-0000-4000-8000-000000000001",
      sessionId: "fastboot-resume:00000000-0000-4000-8000-000000000001", deviceId: "d".repeat(64), expiresIn: "15m"
    });
    await expect(service.verifySessionToken(token, "web-installer-resume")).resolves.toMatchObject({ sub: "00000000-0000-4000-8000-000000000001" });
    await expect(service.verifySessionToken(token, "web-installer")).rejects.toThrow();
  });
});
