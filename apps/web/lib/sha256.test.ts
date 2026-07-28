import { describe, expect, it } from "vitest";
import { IncrementalSha256, sha256Blob } from "./sha256";

describe("incremental SHA-256", () => {
  it("matches standard vectors across arbitrary chunk boundaries", async () => {
    const bytes = new TextEncoder().encode("abc");
    const hash = new IncrementalSha256();
    hash.update(bytes.subarray(0, 1)).update(bytes.subarray(1));
    expect(hash.digestHex()).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    await expect(sha256Blob(new Blob([bytes]))).resolves.toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });
});
