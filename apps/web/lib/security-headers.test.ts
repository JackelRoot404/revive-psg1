import { describe, expect, it } from "vitest";
import nextConfig from "../next.config";

describe("web security headers", () => {
  it("allows same-origin WebUSB instead of disabling the wizard", async () => {
    const routes = await nextConfig.headers?.();
    const global = routes?.find((route) => route.source === "/:path*");
    const policy = global?.headers.find((header) => header.key === "Permissions-Policy")?.value;

    expect(policy).toContain("usb=(self)");
    expect(policy).not.toContain("usb=()");
  });
});
