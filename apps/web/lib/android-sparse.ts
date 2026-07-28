// Android sparse image writer used for the browser Fastboot transport.
// The input must already have passed the signed-manifest SHA-256 check.

const SPARSE_MAGIC = 0xed26ff3a;
const SPARSE_MAJOR_VERSION = 1;
const SPARSE_HEADER_SIZE = 28;
const CHUNK_HEADER_SIZE = 12;
const CHUNK_RAW = 0xcac1;
const CHUNK_DONT_CARE = 0xcac3;
export const ANDROID_SPARSE_BLOCK_SIZE = 4096;

type Chunk = { type: "raw" | "skip"; startBlock: number; blockCount: number };

/**
 * Converts an exact-size ext4 image into Android sparse segments. Every
 * segment describes the whole logical partition: blocks outside its payload
 * are DONT_CARE chunks, matching AOSP fastboot's `-S` split behavior.
 */
export async function createAndroidSparseSegments(image: Blob, maxDownloadBytes: number): Promise<Blob[]> {
  if (image.size <= 0 || image.size % ANDROID_SPARSE_BLOCK_SIZE !== 0) {
    throw new Error("The system image must be a non-empty 4096-byte-aligned ext4 image.");
  }
  if (!Number.isSafeInteger(maxDownloadBytes) || maxDownloadBytes < SPARSE_HEADER_SIZE + 3 * CHUNK_HEADER_SIZE + ANDROID_SPARSE_BLOCK_SIZE) {
    throw new Error("Fastboot reports an unsafe download window for Android sparse flashing.");
  }

  const totalBlocks = image.size / ANDROID_SPARSE_BLOCK_SIZE;
  if (totalBlocks > 0xffffffff) throw new Error("The system image exceeds Android sparse addressing limits.");
  // Reserve a header plus prefix/raw/suffix chunk headers. A range containing
  // only skipped blocks is merged into an adjacent data range, so every
  // segment contains at least one RAW chunk.
  const blocksPerSegment = Math.floor((maxDownloadBytes - SPARSE_HEADER_SIZE - 3 * CHUNK_HEADER_SIZE) / ANDROID_SPARSE_BLOCK_SIZE);
  const chunks = await classifyChunks(image, totalBlocks);
  const result: Blob[] = [];

  for (let startBlock = 0; startBlock < totalBlocks; startBlock += blocksPerSegment) {
    const endBlock = Math.min(totalBlocks, startBlock + blocksPerSegment);
    const relevant = cropChunks(chunks, startBlock, endBlock);
    if (!relevant.some((chunk) => chunk.type === "raw")) continue;
    const parts: BlobPart[] = [asBlobPart(sparseHeader(totalBlocks, countOutputChunks(relevant, startBlock, endBlock, totalBlocks)))];
    if (startBlock > 0) parts.push(asBlobPart(skipChunk(startBlock)));
    for (const chunk of relevant) {
      if (chunk.type === "skip") {
        parts.push(asBlobPart(skipChunk(chunk.blockCount)));
      } else {
        parts.push(asBlobPart(rawChunk(chunk.blockCount)));
        parts.push(image.slice(chunk.startBlock * ANDROID_SPARSE_BLOCK_SIZE, (chunk.startBlock + chunk.blockCount) * ANDROID_SPARSE_BLOCK_SIZE));
      }
    }
    if (endBlock < totalBlocks) parts.push(asBlobPart(skipChunk(totalBlocks - endBlock)));
    const segment = new Blob(parts, { type: "application/octet-stream" });
    if (segment.size > maxDownloadBytes) throw new Error("Android sparse segment exceeds the Fastboot download window.");
    result.push(segment);
  }
  if (!result.length) throw new Error("The system image contains no writable blocks.");
  return result;
}

async function classifyChunks(image: Blob, totalBlocks: number): Promise<Chunk[]> {
  const chunks: Chunk[] = [];
  // Read in multi-block batches to avoid one Blob read per filesystem block.
  const batchBytes = 4 * 1024 * 1024;
  for (let byteOffset = 0; byteOffset < image.size; byteOffset += batchBytes) {
    const bytes = new Uint8Array(await image.slice(byteOffset, Math.min(image.size, byteOffset + batchBytes)).arrayBuffer());
    for (let offset = 0; offset < bytes.byteLength; offset += ANDROID_SPARSE_BLOCK_SIZE) {
      const block = (byteOffset + offset) / ANDROID_SPARSE_BLOCK_SIZE;
      if (block >= totalBlocks) break;
      appendChunk(chunks, allZero(bytes, offset, ANDROID_SPARSE_BLOCK_SIZE) ? "skip" : "raw", block);
    }
  }
  return chunks;
}

function allZero(bytes: Uint8Array, offset: number, length: number): boolean {
  for (let index = offset; index < offset + length; index += 1) if (bytes[index] !== 0) return false;
  return true;
}

function appendChunk(chunks: Chunk[], type: Chunk["type"], block: number) {
  const previous = chunks.at(-1);
  if (previous && previous.type === type && previous.startBlock + previous.blockCount === block) previous.blockCount += 1;
  else chunks.push({ type, startBlock: block, blockCount: 1 });
}

function cropChunks(chunks: Chunk[], startBlock: number, endBlock: number): Chunk[] {
  return chunks.flatMap((chunk) => {
    const start = Math.max(chunk.startBlock, startBlock);
    const end = Math.min(chunk.startBlock + chunk.blockCount, endBlock);
    return start < end ? [{ type: chunk.type, startBlock: start, blockCount: end - start }] : [];
  });
}

function countOutputChunks(relevant: Chunk[], startBlock: number, endBlock: number, totalBlocks: number): number {
  return relevant.length + Number(startBlock > 0) + Number(endBlock < totalBlocks);
}

function sparseHeader(totalBlocks: number, totalChunks: number): Uint8Array {
  const bytes = new Uint8Array(SPARSE_HEADER_SIZE);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, SPARSE_MAGIC, true);
  view.setUint16(4, SPARSE_MAJOR_VERSION, true);
  view.setUint16(6, 0, true);
  view.setUint16(8, SPARSE_HEADER_SIZE, true);
  view.setUint16(10, CHUNK_HEADER_SIZE, true);
  view.setUint32(12, ANDROID_SPARSE_BLOCK_SIZE, true);
  view.setUint32(16, totalBlocks, true);
  view.setUint32(20, totalChunks, true);
  view.setUint32(24, 0, true);
  return bytes;
}

function rawChunk(blockCount: number): Uint8Array { return chunkHeader(CHUNK_RAW, blockCount, CHUNK_HEADER_SIZE + blockCount * ANDROID_SPARSE_BLOCK_SIZE); }
function skipChunk(blockCount: number): Uint8Array { return chunkHeader(CHUNK_DONT_CARE, blockCount, CHUNK_HEADER_SIZE); }

function chunkHeader(type: number, blockCount: number, totalSize: number): Uint8Array {
  const bytes = new Uint8Array(CHUNK_HEADER_SIZE);
  const view = new DataView(bytes.buffer);
  view.setUint16(0, type, true);
  view.setUint16(2, 0, true);
  view.setUint32(4, blockCount, true);
  view.setUint32(8, totalSize, true);
  return bytes;
}

function asBlobPart(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}
