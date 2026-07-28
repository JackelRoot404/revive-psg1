import { describe, expect, it } from "vitest";
import { ANDROID_SPARSE_BLOCK_SIZE, createAndroidSparseSegments } from "./android-sparse";

describe("Android sparse system-image segments", () => {
  it("uses DONT_CARE for zero blocks while preserving logical block offsets", async () => {
    const raw = new Uint8Array(ANDROID_SPARSE_BLOCK_SIZE * 3);
    raw.fill(0x11, 0, ANDROID_SPARSE_BLOCK_SIZE);
    raw.fill(0x22, ANDROID_SPARSE_BLOCK_SIZE * 2);
    const [segment] = await createAndroidSparseSegments(new Blob([raw]), 32 * 1024);
    expect(segment).toBeDefined();
    if (!segment) throw new Error("expected sparse segment");
    const bytes = new Uint8Array(await segment.arrayBuffer());
    const view = new DataView(bytes.buffer);
    expect(view.getUint32(0, true)).toBe(0xed26ff3a);
    expect(view.getUint32(12, true)).toBe(ANDROID_SPARSE_BLOCK_SIZE);
    expect(view.getUint32(16, true)).toBe(3);
    expect(view.getUint32(20, true)).toBe(3);
    expect(view.getUint16(28, true)).toBe(0xcac1);
    expect(view.getUint16(28 + 12 + ANDROID_SPARSE_BLOCK_SIZE, true)).toBe(0xcac3);
    expect(view.getUint16(28 + 12 + ANDROID_SPARSE_BLOCK_SIZE + 12, true)).toBe(0xcac1);
  });

  it("splits raw data below the Fastboot maximum and retains full-image addressing", async () => {
    const raw = new Uint8Array(ANDROID_SPARSE_BLOCK_SIZE * 20);
    raw.fill(0x7f);
    const limit = ANDROID_SPARSE_BLOCK_SIZE * 8;
    const segments = await createAndroidSparseSegments(new Blob([raw]), limit);
    expect(segments.length).toBeGreaterThan(1);
    for (const segment of segments) {
      expect(segment.size).toBeLessThanOrEqual(limit);
      const view = new DataView(await segment.arrayBuffer());
      expect(view.getUint32(16, true)).toBe(20);
    }
  });
});
