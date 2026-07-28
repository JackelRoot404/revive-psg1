import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";

// WebCrypto accepts only a complete ArrayBuffer. This wrapper retains the
// browser-friendly incremental API required for multi-gigabyte firmware files.
export class IncrementalSha256 {
  private readonly hash = sha256.create();
  private finished = false;

  update(input: Uint8Array): this {
    if (this.finished) throw new Error("SHA-256 digest has already been finalized.");
    this.hash.update(input);
    return this;
  }

  digestHex(): string {
    if (this.finished) throw new Error("SHA-256 digest has already been finalized.");
    this.finished = true;
    return bytesToHex(this.hash.digest());
  }
}

export async function sha256Blob(blob: Blob, onProgress?: (completed: number, total: number) => void): Promise<string> {
  const hash = new IncrementalSha256();
  const reader = blob.stream().getReader();
  let completed = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      hash.update(value); completed += value.byteLength; onProgress?.(completed, blob.size);
    }
  } finally { reader.releaseLock(); }
  return hash.digestHex();
}
