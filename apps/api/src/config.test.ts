import { describe, expect, it } from "vitest";
import { loadConfig } from "./config";

const production = {
  NODE_ENV: "production",
  PUBLIC_API_URL: "https://api.revivepsg.com",
  PUBLIC_WEB_URL: "https://revivepsg.com",
  ALLOWED_ORIGINS: "https://revivepsg.com",
  DATABASE_URL: "postgres://example",
  DATABASE_CA_PEM: "-----BEGIN CERTIFICATE-----\\nexample\\n-----END CERTIFICATE-----",
  VALKEY_URL: "rediss://example",
  SESSION_TOKEN_SECRET: "x".repeat(32),
  LICENSE_PRIVATE_KEY_PEM: "private",
  LICENSE_PUBLIC_KEY_PEM: "public",
  RELEASE_PUBLIC_KEY_PEM: "release-public",
  SOLANA_RPC_PRIMARY: "https://primary.example",
  SOLANA_RPC_FALLBACK: "https://fallback.example",
  SPACES_ACCESS_KEY: "access",
  SPACES_SECRET_KEY: "secret"
};

describe("production configuration", () => {
  it("accepts an App Platform CA PEM secret and expands escaped newlines", () => {
    expect(loadConfig(production).databaseCaPem).toContain("\nexample\n");
  });

  it("fails closed without distributed replay state", () => {
    const { VALKEY_URL: _, ...missing } = production;
    expect(() => loadConfig(missing)).toThrow(/Valkey/);
  });

  it("requires a fallback finalized-payment RPC", () => {
    const { SOLANA_RPC_FALLBACK: _, ...missing } = production;
    expect(() => loadConfig(missing)).toThrow(/fallback Solana RPC/);
  });
});

describe("local configuration", () => {
  it("uses safe localhost defaults so the API can start without copying env templates", () => {
    const config = loadConfig({ NODE_ENV: "development" });
    expect(config.publicApiUrl).toBe("http://localhost:8080");
    expect(config.databaseUrl).toContain("localhost:5432/revive_psg1");
    expect(config.earlyAccessFree).toBe(true);
  });

  it("restores paid enforcement with one feature flag", () => {
    expect(loadConfig({ NODE_ENV: "development", EARLY_ACCESS_FREE: "false" }).earlyAccessFree).toBe(false);
  });

  it("allows the deterministic hardware fixture only when explicitly enabled in development", () => {
    expect(loadConfig({ NODE_ENV: "development", REVIVE_DEV_HARDWARE_FIXTURE: "true" }).developmentHardwareFixture).toBe(true);
  });

  it("defaults compatibility checker only mode to enabled", () => {
    expect(loadConfig({ NODE_ENV: "development" }).compatibilityCheckerOnly).toBe(true);
    expect(loadConfig({ NODE_ENV: "development", COMPATIBILITY_CHECKER_ONLY: "false" }).compatibilityCheckerOnly).toBe(false);
  });

  it("keeps destructive browser installation opt-in", () => {
    expect(loadConfig({ NODE_ENV: "development" }).betaBrowserInstaller).toBe(false);
    expect(loadConfig({ NODE_ENV: "development", BETA_BROWSER_INSTALLER: "true" }).betaBrowserInstaller).toBe(true);
  });

  it("refuses the deterministic hardware fixture in production", () => {
    expect(() => loadConfig({ ...production, REVIVE_DEV_HARDWARE_FIXTURE: "true" })).toThrow(/forbidden in production/i);
  });
});
