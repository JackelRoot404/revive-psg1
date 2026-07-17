import { describe, expect, it } from "vitest";
import { deviceIdForSerial, normalizeSerial, parseFastbootResponse, parseFastbootSize } from "./webusb-psg1";

describe("PSG1 WebUSB transport primitives", () => {
  it("normalizes and hashes the same manufacturer serial deterministically", async () => {
    expect(normalizeSerial(" psg1-test_0001-a ")).toBe("PSG1TEST0001A");
    await expect(deviceIdForSerial("PSG1-TEST-0001-A")).resolves.toMatch(/^[a-f0-9]{64}$/u);
    expect(await deviceIdForSerial("PSG1-TEST-0001-A")).toBe(await deviceIdForSerial("psg1_test 0001_a"));
  });

  it("parses only allowlisted Fastboot response statuses", () => {
    expect(parseFastbootResponse(new TextEncoder().encode("OKAY0x1000"))).toEqual({ status: "OKAY", payload: "0x1000" });
    expect(() => parseFastbootResponse(new TextEncoder().encode("NOPE"))).toThrow(/unknown status/u);
  });

  it("accepts bounded decimal and hexadecimal partition sizes", () => {
    expect(parseFastbootSize("0x1000")).toBe(4096);
    expect(parseFastbootSize("4096")).toBe(4096);
    expect(parseFastbootSize("not-a-size")).toBe(0);
  });
});
