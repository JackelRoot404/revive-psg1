import { sha256Blob } from "./sha256";

export type DownloadArtifact = { id: string; size: number; sha256: string; objectKey: string };
export type ArtifactProgress = { artifactId: string; downloaded: number; total: number; phase: "download" | "verify" };

const ROOT = "revive-psg1-artifacts-v1";
const JOURNAL = "active-installation.json";

export type InstallationJournal = {
  deviceId: string;
  bootloaderSerial: string;
  profileId: string;
  releaseVersion: string;
  artifactHashes: Record<string, string>;
  stage: string;
  updatedAt: string;
};

export async function downloadVerifiedArtifact(artifact: DownloadArtifact, url: string, onProgress?: (progress: ArtifactProgress) => void): Promise<File> {
  validateArtifact(artifact);
  const directory = await artifactDirectory();
  const fileHandle = await directory.getFileHandle(artifact.sha256, { create: true });
  let existing = await fileHandle.getFile();
  if (existing.size > artifact.size) {
    await truncate(fileHandle); existing = await fileHandle.getFile();
  }
  if (existing.size < artifact.size) await downloadInto(fileHandle, artifact, url, existing.size, onProgress);
  const complete = await fileHandle.getFile();
  if (complete.size !== artifact.size) throw new Error(`Artifact ${artifact.id} download size does not match its signed manifest.`);
  onProgress?.({ artifactId: artifact.id, downloaded: complete.size, total: artifact.size, phase: "verify" });
  const hash = await sha256Blob(complete, (downloaded, total) => onProgress?.({ artifactId: artifact.id, downloaded, total, phase: "verify" }));
  if (hash !== artifact.sha256) {
    await directory.removeEntry(artifact.sha256).catch(() => undefined);
    throw new Error(`Artifact ${artifact.id} failed SHA-256 verification and was removed.`);
  }
  await writeMetadata(directory, artifact);
  return complete;
}

export async function loadVerifiedArtifact(artifact: DownloadArtifact, onProgress?: (progress: ArtifactProgress) => void): Promise<File> {
  validateArtifact(artifact);
  const directory = await artifactDirectory();
  const metadata = await readMetadata(directory, artifact.sha256);
  if (!metadata || metadata.id !== artifact.id || metadata.size !== artifact.size || metadata.objectKey !== artifact.objectKey) {
    throw new Error(`Artifact ${artifact.id} is not available in this browser cache.`);
  }
  const file = await (await directory.getFileHandle(artifact.sha256)).getFile();
  if (file.size !== artifact.size) throw new Error(`Cached artifact ${artifact.id} has an unexpected size.`);
  onProgress?.({ artifactId: artifact.id, downloaded: file.size, total: artifact.size, phase: "verify" });
  const hash = await sha256Blob(file, (downloaded, total) => onProgress?.({ artifactId: artifact.id, downloaded, total, phase: "verify" }));
  if (hash !== artifact.sha256) throw new Error(`Cached artifact ${artifact.id} failed SHA-256 verification.`);
  return file;
}

export async function assertArtifactCapacity(artifacts: readonly Pick<DownloadArtifact, "size">[]): Promise<void> {
  const expected = artifacts.reduce((total, artifact) => total + artifact.size, 0);
  const estimate = await navigator.storage.estimate();
  if ((estimate.quota ?? 0) - (estimate.usage ?? 0) < expected) {
    throw new Error("The browser does not have enough persistent storage for this signed release.");
  }
}

/** Stores only non-secret resumable state. Tokens remain in session storage. */
export async function saveInstallationJournal(journal: InstallationJournal): Promise<void> {
  if (!journal.deviceId || !journal.bootloaderSerial || !journal.profileId || !journal.releaseVersion || !journal.stage) {
    throw new Error("The installation journal is incomplete.");
  }
  const directory = await artifactDirectory();
  const handle = await directory.getFileHandle(JOURNAL, { create: true });
  const writable = await handle.createWritable();
  await writable.write(JSON.stringify({ ...journal, updatedAt: new Date().toISOString() }));
  await writable.close();
}

export async function loadInstallationJournal(): Promise<InstallationJournal | null> {
  try {
    const directory = await artifactDirectory();
    const journal = JSON.parse(await (await directory.getFileHandle(JOURNAL)).getFile().then((file) => file.text())) as InstallationJournal;
    if (!journal || typeof journal !== "object" || typeof journal.deviceId !== "string" || typeof journal.bootloaderSerial !== "string"
      || typeof journal.profileId !== "string" || typeof journal.releaseVersion !== "string" || typeof journal.stage !== "string"
      || !journal.artifactHashes || typeof journal.artifactHashes !== "object") return null;
    return journal;
  } catch { return null; }
}

async function downloadInto(handle: FileSystemFileHandle, artifact: DownloadArtifact, url: string, offset: number, onProgress?: (progress: ArtifactProgress) => void) {
  const response = await fetch(url, { headers: offset ? { Range: `bytes=${offset}-` } : {}, cache: "no-store" });
  if (!response.ok || !response.body) throw new Error(`Artifact ${artifact.id} could not be downloaded from the private release store.`);
  let position = offset;
  const ranged = offset > 0 && response.status === 206;
  if (ranged && !response.headers.get("content-range")?.startsWith(`bytes ${offset}-`)) {
    throw new Error(`Artifact ${artifact.id} returned an invalid range response.`);
  }
  if (offset > 0 && !ranged && response.status !== 200) throw new Error(`Artifact ${artifact.id} did not honor the resume request.`);
  const writable = await handle.createWritable({ keepExistingData: ranged });
  if (!ranged) position = 0;
  try {
    const reader = response.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      if (position + value.byteLength > artifact.size) throw new Error(`Artifact ${artifact.id} exceeded its signed size.`);
      await writable.write({ type: "write", position, data: value });
      position += value.byteLength;
      onProgress?.({ artifactId: artifact.id, downloaded: position, total: artifact.size, phase: "download" });
    }
    await writable.close();
  } catch (cause) {
    await writable.abort().catch(() => undefined);
    throw cause;
  }
}

async function artifactDirectory(): Promise<FileSystemDirectoryHandle> {
  if (!("storage" in navigator) || typeof navigator.storage.getDirectory !== "function") {
    throw new Error("This browser does not provide the persistent storage required for verified flashing artifacts.");
  }
  return (await navigator.storage.getDirectory()).getDirectoryHandle(ROOT, { create: true });
}

async function truncate(handle: FileSystemFileHandle) { const writable = await handle.createWritable(); await writable.truncate(0); await writable.close(); }
async function writeMetadata(directory: FileSystemDirectoryHandle, artifact: DownloadArtifact) {
  const handle = await directory.getFileHandle(`${artifact.sha256}.json`, { create: true });
  const writable = await handle.createWritable(); await writable.write(JSON.stringify(artifact)); await writable.close();
}
async function readMetadata(directory: FileSystemDirectoryHandle, sha256: string): Promise<DownloadArtifact | null> {
  try { return JSON.parse(await (await directory.getFileHandle(`${sha256}.json`)).getFile().then((file) => file.text())) as DownloadArtifact; }
  catch { return null; }
}
function validateArtifact(artifact: DownloadArtifact) {
  if (!/^[a-z0-9][a-z0-9_-]{0,99}$/u.test(artifact.id) || !Number.isSafeInteger(artifact.size) || artifact.size <= 0 || !/^[a-f0-9]{64}$/u.test(artifact.sha256) || !artifact.objectKey) {
    throw new Error("Release manifest contains an invalid artifact descriptor.");
  }
}
