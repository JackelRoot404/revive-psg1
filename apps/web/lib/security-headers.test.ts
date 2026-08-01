import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("web security headers", () => {
  it("allows same-origin WebUSB in the static host policy", () => {
    const netlifyConfig = readFileSync(resolve(process.cwd(), "../..", "netlify.toml"), "utf8");

    expect(netlifyConfig).toContain('Permissions-Policy = "camera=(), microphone=(), geolocation=(), usb=(self)"');
    expect(netlifyConfig).not.toContain("usb=()");
  });
});
