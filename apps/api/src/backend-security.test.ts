import { describe, expect, it } from "vitest";
import { launchGateSetComplete, sanitizeTelemetryRecord, sanitizeText } from "./app";

const gateKeys = [
  "beta_licenses_redeemed_10", "windows_success_5", "macos_success_5", "all_beta_profiles_signed",
  "no_unrecovered_beta_devices", "serial_uniqueness_confirmed", "stock_restore_tested", "adversarial_suite_passed"
];

describe("backend security invariants", () => {
  const passedGates = gateKeys.map((key) => ({ key, passed: true, evidence: { artifact: "signed-report" }, verifiedBy: "release-manager", verifiedAt: new Date() }));

  it("keeps public sales closed before the tenth atomic beta redemption", () => expect(launchGateSetComplete(passedGates, 9)).toBe(false));
  it("keeps public sales closed when a checkbox has no evidence", () => expect(launchGateSetComplete(passedGates.map((gate, index) => index ? gate : { ...gate, evidence: {} }), 10)).toBe(false));
  it("opens the derived gate only with all evidence and ten redemptions", () => expect(launchGateSetComplete(passedGates, 10)).toBe(true));

  it("removes sensitive compatibility fields and serial/token values", () => {
    expect(sanitizeTelemetryRecord({
      serial: "PS01-0000-TEST-A0-000000",
      board: "RK3588S PSG1 V11",
      note: "device PS01-0000-TEST-A0-000000 Bearer abc.def.ghi"
    })).toEqual({ board: "RK3588S PSG1 V11", note: "device [redacted-device-serial] Bearer [redacted]" });
  });

  it("bounds redacted crash data", () => expect(sanitizeText("x".repeat(20_000)).length).toBeLessThanOrEqual(16_000));
});
