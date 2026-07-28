import { describe, expect, it } from "vitest";
import { buildApp, installerBlockedInScanOnlyMode } from "./app";
import { loadConfig } from "./config";

describe("compatibility checker only mode", () => {
  it("defaults to scan-only on", () => {
    expect(loadConfig({ NODE_ENV: "development" }).compatibilityCheckerOnly).toBe(true);
  });

  it("opens full installer routes only with the explicit beta gate", () => {
    expect(loadConfig({ NODE_ENV: "development", COMPATIBILITY_CHECKER_ONLY: "false" }).compatibilityCheckerOnly).toBe(false);
    expect(installerBlockedInScanOnlyMode(loadConfig({ NODE_ENV: "development", COMPATIBILITY_CHECKER_ONLY: "false" }))).toBe(true);
    expect(installerBlockedInScanOnlyMode(loadConfig({ NODE_ENV: "development", COMPATIBILITY_CHECKER_ONLY: "false", BETA_BROWSER_INSTALLER: "true" }))).toBe(false);
  });

  it("blocks installer routes before auth when scan-only is enabled", async () => {
    const config = loadConfig({ NODE_ENV: "development", COMPATIBILITY_CHECKER_ONLY: "true" });
    const app = await buildApp({
      config,
      db: {} as never
    });

    for (const route of [
      { method: "POST" as const, url: "/v1/early-access/activate" },
      { method: "POST" as const, url: "/v1/web/wizard/challenge" },
      { method: "POST" as const, url: "/v1/web/wizard/verify" },
      { method: "GET" as const, url: "/v1/releases/stable" },
      { method: "POST" as const, url: "/v1/beta/resume" },
      { method: "POST" as const, url: "/v1/licenses/00000000-0000-4000-8000-000000000001/installation-started" }
    ]) {
      const response = await app.inject(route);
      expect(response.statusCode, route.url).toBe(403);
      expect(JSON.parse(response.body).code, route.url).toBe("COMPATIBILITY_CHECKER_ONLY");
    }

    await app.close();
  });

  it("removes legacy payment and recovery routes in beta mode", async () => {
    const app = await buildApp({
      config: loadConfig({ NODE_ENV: "development", COMPATIBILITY_CHECKER_ONLY: "false", BETA_BROWSER_INSTALLER: "true" }),
      db: {} as never
    });
    for (const url of ["/v1/wallet/challenge", "/v1/orders", "/v1/licenses/00000000-0000-4000-8000-000000000001/refunds", "/v1/devices/a".padEnd(78, "a") + "/entitlement/recover"]) {
      const response = await app.inject({ method: "POST", url });
      expect(response.statusCode, url).toBe(404);
      expect(JSON.parse(response.body).code, url).toBe("BETA_ONLY_ROUTE_DISABLED");
    }
    await app.close();
  });
});
