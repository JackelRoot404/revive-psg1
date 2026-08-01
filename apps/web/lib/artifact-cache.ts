import { sha256Blob } from "./sha256";
import type { WebCompatibilityScan } from "./webusb-psg1";

export type DownloadArtifact = { id: string; size: number; sha256: string; objectKey: string };
export type ArtifactProgress = { artifactId: string; downloaded: number; total: number; phase: "download" | "verify" };

const ROOT = "revive-psg1-artifacts-v1";
const JOURNAL = "active-installation.json";
const RESUME_CONTEXT = "active-installation-resume.json";

export type InstallationJournal = {
  deviceId: string;
  bootloaderSerial: string;
  profileId: string;
  releaseVersion: string;
  artifactHashes: Record<string, string>;
  stage: string;
  /** The last destructive operation being journaled; contains no secrets. */
  operation: string;
  /**
   * A write-ahead state. `intent` is persisted before a command is attempted,
   * `sent` immediately before the USB command, and `verified` only after the
   * device acknowledged it. A later resume treats `intent`/`sent` as
   * indeterminate and rechecks the physical PSG1 before continuing.
   */
  operationState: "intent" | "sent" | "verified" | "unknown";
  /** Zero-based exact Fastboot transfer checkpoint; 0/1 for ordinary commands. */
  operationIndex: number;
  /** Number of idempotent transfers in this operation; 1 for ordinary commands. */
  operationCount: number;
  updatedAt: string;
};

/**
 * The opaque credential is scoped to one already-bound release and is rotated
 * by the API whenever it is used. It remains in browser-origin persistent
 * storage solely so a tab/browser crash in Fastboot can resume; never copy it
 * to sessionStorage, logs, support messages, or a server journal.
 */
export type PersistentInstallationResume = {
  licenseId: string;
  deviceId: string;
  bootloaderSerial: string;
  profileId: string;
  releaseVersion: string;
  resumeCredential: string;
  resumeCredentialExpiresAt: string;
  scan: WebCompatibilityScan;
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
  if (!journal.deviceId || !journal.bootloaderSerial || !journal.profileId || !journal.releaseVersion || !journal.stage
    || !journal.operation || !isOperationState(journal.operationState)
    || !isOperationSegment(journal.operationIndex, journal.operationCount)) {
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
    return normalizeInstallationJournal(JSON.parse(await (await directory.getFileHandle(JOURNAL)).getFile().then((file) => file.text())));
  } catch { return null; }
}

export async function savePersistentInstallationResume(context: PersistentInstallationResume): Promise<void> {
  if (!isPersistentInstallationResume(context)) throw new Error("The durable installation resume record is incomplete.");
  const directory = await artifactDirectory();
  const handle = await directory.getFileHandle(RESUME_CONTEXT, { create: true });
  const writable = await handle.createWritable();
  await writable.write(JSON.stringify(context));
  await writable.close();
}

export async function loadPersistentInstallationResume(): Promise<PersistentInstallationResume | null> {
  try {
    const directory = await artifactDirectory();
    const value: unknown = JSON.parse(await (await directory.getFileHandle(RESUME_CONTEXT)).getFile().then((file) => file.text()));
    return isPersistentInstallationResume(value) ? value : null;
  } catch { return null; }
}

export async function clearPersistentInstallationResume(): Promise<void> {
  try {
    const directory = await artifactDirectory();
    await directory.removeEntry(RESUME_CONTEXT);
  } catch { /* A missing persistent journal is already cleared. */ }
}

export function normalizeInstallationJournal(value: unknown): InstallationJournal | null {
  if (!value || typeof value !== "object") return null;
  const journal = value as Partial<InstallationJournal>;
  if (typeof journal.deviceId !== "string" || !journal.deviceId || typeof journal.bootloaderSerial !== "string" || !journal.bootloaderSerial
    || typeof journal.profileId !== "string" || !journal.profileId || typeof journal.releaseVersion !== "string" || !journal.releaseVersion
    || typeof journal.stage !== "string" || !journal.stage || !journal.artifactHashes || typeof journal.artifactHashes !== "object") return null;
  // Journals written before write-ahead tracking remain resumable, but are
  // intentionally treated as indeterminate rather than silently trusted.
  const operation = typeof journal.operation === "string" && journal.operation ? journal.operation : "legacy_resume";
  const operationState = isOperationState(journal.operationState) ? journal.operationState : "unknown";
  const hasSegment = isOperationSegment(journal.operationIndex, journal.operationCount);
  return {
    deviceId: journal.deviceId,
    bootloaderSerial: journal.bootloaderSerial,
    profileId: journal.profileId,
    releaseVersion: journal.releaseVersion,
    artifactHashes: journal.artifactHashes as Record<string, string>,
    stage: journal.stage,
    operation,
    operationState,
    operationIndex: hasSegment ? Number(journal.operationIndex) : 0,
    operationCount: hasSegment ? Number(journal.operationCount) : 1,
    updatedAt: typeof journal.updatedAt === "string" ? journal.updatedAt : ""
  };
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

function isOperationState(value: unknown): value is InstallationJournal["operationState"] {
  return value === "intent" || value === "sent" || value === "verified" || value === "unknown";
}

function isOperationSegment(index: unknown, count: unknown): index is number {
  return Number.isInteger(index) && Number.isInteger(count)
    && typeof index === "number" && typeof count === "number"
    && index >= 0 && count >= 1 && index < count && count <= 100_000;
}

function isPersistentInstallationResume(value: unknown): value is PersistentInstallationResume {
  if (!value || typeof value !== "object") return false;
  const context = value as Partial<PersistentInstallationResume>;
  const scan = context.scan as Partial<WebCompatibilityScan> | undefined;
  return typeof context.licenseId === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(context.licenseId)
    && typeof context.deviceId === "string" && /^[a-f0-9]{64}$/u.test(context.deviceId)
    && typeof context.bootloaderSerial === "string" && Boolean(context.bootloaderSerial)
    && typeof context.profileId === "string" && Boolean(context.profileId)
    && typeof context.releaseVersion === "string" && Boolean(context.releaseVersion)
    && typeof context.resumeCredential === "string" && /^rpi_[A-Za-z0-9_-]{32,128}$/u.test(context.resumeCredential)
    && typeof context.resumeCredentialExpiresAt === "string" && Date.parse(context.resumeCredentialExpiresAt) > Date.now()
    && Boolean(scan) && scan?.deviceId === context.deviceId && scan?.bootloaderSerial === context.bootloaderSerial
    && scan?.serialVerified === true && scan?.immutableSerialVerified === true;
}
