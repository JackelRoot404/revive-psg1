import { describe, expect, it } from "vitest";
import { buildApp, installerBlockedInScanOnlyMode } from "./app";
import { loadConfig } from "./config";

describe("compatibility checker only mode", () => {
  it("defaults to scan-only on", () => {
    expect(loadConfig({ NODE_ENV: "development" }).compatibilityCheckerOnly).toBe(true);
  });

  it("opens installer routes only through an explicit authoritative mode", () => {
    expect(installerBlockedInScanOnlyMode(loadConfig({ NODE_ENV: "development" }))).toBe(true);
    expect(installerBlockedInScanOnlyMode(loadConfig({ NODE_ENV: "development", INSTALLER_MODE: "private_beta" }))).toBe(false);
    expect(installerBlockedInScanOnlyMode(loadConfig({ NODE_ENV: "development", INSTALLER_MODE: "public" }))).toBe(false);
  });

  it("blocks installer routes before auth when scan-only is enabled", async () => {
    const config = loadConfig({ NODE_ENV: "development", COMPATIBILITY_CHECKER_ONLY: "true" });
    const app = await buildApp({
      config,
      db: {} as never
    });

    for (const route of [
      { method: "POST" as const, url: "/v1/early-access/activate" },
      { method: "POST" as const, url: "/v1/public/activate" },
      { method: "POST" as const, url: "/v1/beta/resume" }
    ]) {
      const response = await app.inject(route);
      expect(response.statusCode, route.url).toBe(403);
      expect(JSON.parse(response.body).code, route.url).toBe("COMPATIBILITY_CHECKER_ONLY");
    }

    // These routes authenticate before applying the scan-only restriction so
    // a previously started device can retrieve only its exact bound release
    // during an emergency pause. An anonymous request has no resume claim.
    for (const route of [
      { method: "GET" as const, url: "/v1/releases/stable" },
      { method: "POST" as const, url: "/v1/licenses/00000000-0000-4000-8000-000000000001/installation-started" },
      { method: "POST" as const, url: "/v1/licenses/00000000-0000-4000-8000-000000000001/installation-journal" }
    ]) {
      const response = await app.inject(route);
      expect(response.statusCode, route.url).toBe(401);
      expect(JSON.parse(response.body).code, route.url).toBe("LICENSE_REQUIRED");
    }

    for (const url of ["/v1/web/wizard/challenge", "/v1/web/wizard/verify"]) {
      const response = await app.inject({ method: "POST", url });
      expect(response.statusCode, url).toBe(404);
      expect(JSON.parse(response.body).code, url).toBe("BETA_ONLY_ROUTE_DISABLED");
    }

    await app.close();
  });

  it("removes legacy payment and recovery routes in beta mode", async () => {
    const app = await buildApp({
      config: loadConfig({ NODE_ENV: "development", INSTALLER_MODE: "private_beta" }),
      db: {} as never
    });
    for (const url of ["/v1/wallet/challenge", "/v1/orders", "/v1/licenses/00000000-0000-4000-8000-000000000001/refunds", "/v1/devices/a".padEnd(78, "a") + "/entitlement/recover"]) {
      const response = await app.inject({ method: "POST", url });
      expect(response.statusCode, url).toBe(404);
      expect(JSON.parse(response.body).code, url).toBe("BETA_ONLY_ROUTE_DISABLED");
    }
    await app.close();
  });

  it("keeps invite-only beta activation out of public mode", async () => {
    const app = await buildApp({
      config: loadConfig({ NODE_ENV: "development", INSTALLER_MODE: "public" }),
      db: {} as never
    });
    for (const url of ["/v1/beta/activate", "/v1/beta/resume"]) {
      const response = await app.inject({ method: "POST", url });
      expect(response.statusCode, url).toBe(403);
      expect(JSON.parse(response.body).code, url).toBe("PRIVATE_BETA_MODE_REQUIRED");
    }
    const legacy = await app.inject({ method: "POST", url: "/v1/early-access/activate" });
    expect(legacy.statusCode).toBe(403);
    expect(JSON.parse(legacy.body).code).toBe("PUBLIC_ACTIVATION_REQUIRED");
    await app.close();
  });

  it("pauses new public starts without stranding the authenticated public-resume route", async () => {
    const app = await buildApp({
      config: loadConfig({
        NODE_ENV: "development",
        INSTALLER_MODE: "public",
        INSTALLER_NEW_STARTS_ENABLED: "false"
      }),
      db: {} as never
    });
    const newStart = await app.inject({ method: "POST", url: "/v1/public/activate" });
    expect(newStart.statusCode).toBe(503);
    expect(JSON.parse(newStart.body).code).toBe("INSTALLER_NEW_STARTS_PAUSED");

    // A resumed, boundary-crossed PSG1 must authenticate normally instead of
    // being rejected by the global new-start brake. The browser/UI separately
    // permits a stock-locked scan to request this exact-resume authorization.
    const resume = await app.inject({ method: "POST", url: "/v1/public/resume" });
    expect(resume.statusCode).toBe(401);
    expect(JSON.parse(resume.body).code).not.toBe("INSTALLER_NEW_STARTS_PAUSED");
    await app.close();
  });
});
