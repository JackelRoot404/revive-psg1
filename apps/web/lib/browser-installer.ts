import { loadVerifiedArtifact, saveInstallationJournal, type DownloadArtifact, type InstallationJournal } from "./artifact-cache";
import { createAndroidSparseSegments } from "./android-sparse";
import { WebAdbPsg1, WebFastbootPsg1, type AdbCompatibilityScan, type WebCompatibilityScan } from "./webusb-psg1";
import type { Psg1FlashPlan } from "@revive-psg1/contracts";

export type BrowserInstallArtifact = DownloadArtifact & {
  kind: "system" | "vbmeta" | "apk";
  component: "android_system" | "verified_boot" | "diagnostics" | "diagnostics_test" | "aurora_store" | "retroarch";
  signerSha256?: string;
  packageName?: string;
  versionName?: string;
};

export type BrowserInstallStep =
  | "awaiting_bootloader_unlock"
  | "awaiting_unlocked_android"
  | "awaiting_vbmeta_bootloader"
  | "awaiting_system_android"
  | "awaiting_fastbootd_system"
  | "awaiting_postflash_android"
  | "awaiting_first_cold_boot"
  | "awaiting_second_cold_boot"
  | "complete";

type Context = {
  scan: WebCompatibilityScan;
  profileId: string;
  releaseVersion: string;
  flashPlan: Psg1FlashPlan;
  artifacts: BrowserInstallArtifact[];
  /** Last server-authoritative checkpoint recovered during an exact resume. */
  resumeCheckpoint?: Pick<InstallationJournal, "stage" | "operation" | "operationState" | "operationIndex" | "operationCount">;
  /** Persists the non-secret write-ahead state to the device-bound API journal. */
  journalSink?: (journal: InstallationJournal) => Promise<void>;
};

/**
 * The only destructive browser operation path. Every method requires a fresh
 * user-selected USB device after a reboot and rechecks its immutable serial.
 */
export class BrowserInstaller {
  private readonly artifactByComponent: Map<BrowserInstallArtifact["component"], BrowserInstallArtifact>;
  private readonly journalBase: Omit<InstallationJournal, "stage" | "operation" | "operationState" | "operationIndex" | "operationCount" | "updatedAt">;
  private checkpoint: Context["resumeCheckpoint"];

  constructor(private readonly context: Context) {
    if (!context.scan.bootloaderSerial || !context.profileId || !context.releaseVersion) {
      throw new Error("The authorized installation context is incomplete.");
    }
    assertPsg1FlashPlan(context.flashPlan);
    this.artifactByComponent = new Map(context.artifacts.map((artifact) => [artifact.component, artifact]));
    for (const component of ["android_system", "verified_boot", "diagnostics", "diagnostics_test", "aurora_store", "retroarch"] as const) {
      if (!this.artifactByComponent.has(component)) throw new Error(`The signed release is missing ${component}.`);
    }
    this.journalBase = {
      deviceId: context.scan.deviceId,
      bootloaderSerial: context.scan.bootloaderSerial,
      profileId: context.profileId,
      releaseVersion: context.releaseVersion,
      artifactHashes: Object.fromEntries(context.artifacts.map((artifact) => [artifact.id, artifact.sha256]))
    };
    this.checkpoint = context.resumeCheckpoint;
  }

  get latestCheckpoint(): Context["resumeCheckpoint"] {
    return this.checkpoint;
  }

  async begin(): Promise<BrowserInstallStep> {
    const adb = await WebAdbPsg1.request();
    try {
      await this.runOperation("begin", "start", "awaiting_bootloader_unlock", () => this.assertFreshStockLockedPreflight(adb), () => adb.rebootBootloader());
      return "awaiting_bootloader_unlock";
    } finally { await adb.close().catch(() => undefined); }
  }

  async unlock(): Promise<BrowserInstallStep> {
    let fastboot: WebFastbootPsg1;
    try {
      fastboot = await WebFastbootPsg1.request();
    } catch (cause) {
      if (!fastbootPickerUnavailable(cause)) throw cause;
      // If the reboot was journaled as sent but the handset is still in
      // Android, expose the source-mode retry instead of trapping the owner
      // in an empty Fastboot picker. Reboot is idempotent and remains inside
      // the same signed checkpoint.
      const adb = await WebAdbPsg1.request();
      try {
        await this.runOperation("begin", "start", "awaiting_bootloader_unlock", () => this.assertFreshStockLockedPreflight(adb), () => adb.rebootBootloader());
        return "awaiting_bootloader_unlock";
      } finally { await adb.close().catch(() => undefined); }
    }
    try {
      const prepare = () => this.assertFastbootIdentityAndMode(fastboot, "bootloader");
      // A crash after Fastboot accepted the initial reboot can leave the
      // device in bootloader mode before the browser wrote `verified`. Seeing
      // the same protocol-serial device in that expected mode resolves only
      // that idempotent reboot checkpoint; it never skips an unlock/flash.
      await this.verifyReconnectCheckpoint("begin", "awaiting_bootloader_unlock", prepare);
      // Fastboot ACK only proves the command was accepted. The following
      // Android reconnect verifies that the owner confirmed the handset-side
      // prompt and verified boot is actually unlocked before any flash step.
      await this.runOperation(
        "unlock", "awaiting_bootloader_unlock", "awaiting_unlocked_android",
        prepare,
        () => fastboot.unlockVerifiedBoot(),
        { deferVerification: true }
      );
      return "awaiting_unlocked_android";
    } finally { await fastboot.close().catch(() => undefined); }
  }

  async rebootForVbmeta(): Promise<BrowserInstallStep> {
    const adb = await WebAdbPsg1.request();
    try {
      await this.verifyUnlockOnAndroid(adb);
      await this.runOperation("reboot_for_vbmeta", "awaiting_unlocked_android", "awaiting_vbmeta_bootloader", () => this.assertAdbIdentity(adb, true), () => adb.rebootBootloader());
      return "awaiting_vbmeta_bootloader";
    } finally { await adb.close().catch(() => undefined); }
  }

  async flashVbmeta(): Promise<BrowserInstallStep> {
    let fastboot: WebFastbootPsg1;
    try {
      fastboot = await WebFastbootPsg1.request();
    } catch (cause) {
      if (!fastbootPickerUnavailable(cause)) throw cause;
      const adb = await WebAdbPsg1.request();
      try {
        await this.runOperation("reboot_for_vbmeta", "awaiting_unlocked_android", "awaiting_vbmeta_bootloader", () => this.assertAdbIdentity(adb, true), () => adb.rebootBootloader());
        return "awaiting_vbmeta_bootloader";
      } finally { await adb.close().catch(() => undefined); }
    }
    try {
      const prepare = () => this.assertFastbootIdentityAndMode(fastboot, "bootloader");
      await this.verifyReconnectCheckpoint("reboot_for_vbmeta", "awaiting_vbmeta_bootloader", prepare);
      if (!this.isOperationSettledOrPast("flash_vbmeta")) {
        await this.runOperation(
          "flash_vbmeta", "awaiting_vbmeta_bootloader", "awaiting_vbmeta_bootloader",
          prepare,
          async (recordSent) => fastboot.flash(
            this.context.flashPlan.vbmetaPartition,
            await loadVerifiedArtifact(this.artifact("verified_boot")),
            recordSent
          ),
          { sentWithinAction: true }
        );
      }
      if (!this.isOperationSettledOrPast("reboot_after_vbmeta")) {
        await this.runOperation(
          "reboot_after_vbmeta", "awaiting_vbmeta_bootloader", "awaiting_system_android",
          prepare,
          () => fastboot.reboot()
        );
      }
      return "awaiting_system_android";
    } finally { await fastboot.close().catch(() => undefined); }
  }

  async rebootForFastbootd(): Promise<BrowserInstallStep> {
    const adb = await WebAdbPsg1.request();
    try {
      const prepare = () => this.assertAdbIdentity(adb, true);
      await this.verifyReconnectCheckpoint("reboot_after_vbmeta", "awaiting_system_android", prepare);
      await this.runOperation("reboot_for_fastbootd", "awaiting_system_android", "awaiting_fastbootd_system", prepare, () => adb.rebootFastboot());
      return "awaiting_fastbootd_system";
    } finally { await adb.close().catch(() => undefined); }
  }

  async flashSystem(): Promise<BrowserInstallStep> {
    let fastboot: WebFastbootPsg1;
    try {
      fastboot = await WebFastbootPsg1.request();
    } catch (cause) {
      if (!fastbootPickerUnavailable(cause)) throw cause;
      const adb = await WebAdbPsg1.request();
      try {
        await this.runOperation("reboot_for_fastbootd", "awaiting_system_android", "awaiting_fastbootd_system", () => this.assertAdbIdentity(adb, true), () => adb.rebootFastboot());
        return "awaiting_fastbootd_system";
      } finally { await adb.close().catch(() => undefined); }
    }
    try {
      const stage = "awaiting_fastbootd_system" as const;
      const prepare = () => this.assertFastbootIdentityAndMode(fastboot, this.context.flashPlan.systemMode);
      await this.verifyReconnectCheckpoint("reboot_for_fastbootd", stage, prepare);
      const system = await loadVerifiedArtifact(this.artifact("android_system"));
      await this.assertFastbootdCapacity(fastboot, system.size);
      if (this.context.flashPlan.resizeLogicalSystem && !this.isOperationSettledOrPast("resize_system")) {
        await this.runOperation("resize_system", stage, stage, prepare, async () => {
          await fastboot.resizeLogicalSystem(system.size);
          await fastboot.assertLogicalSystemCapacity(system.size);
        });
      }
      await this.flashVerifiedSystemSegments(fastboot, system, prepare, stage);
      if (this.context.flashPlan.wipeUserData && !this.isOperationSettledOrPast("wipe_userdata")) {
        await this.runOperation("wipe_userdata", stage, stage, prepare, () => fastboot.wipeUserData());
      }
      if (!this.isOperationSettledOrPast("reboot_after_system")) {
        await this.runOperation("reboot_after_system", stage, "awaiting_postflash_android", prepare, () => fastboot.reboot());
      }
      return "awaiting_postflash_android";
    } finally { await fastboot.close().catch(() => undefined); }
  }

  async installAppsAndReboot(): Promise<BrowserInstallStep> {
    const adb = await WebAdbPsg1.request();
    try {
      const stage = "awaiting_postflash_android" as const;
      const prepare = () => this.assertAdbIdentity(adb, true);
      await this.verifyReconnectCheckpoint("reboot_after_system", stage, prepare);
      for (const component of this.context.flashPlan.postFlashApkComponents) {
        const operation = apkOperation(component);
        if (this.isOperationSettledOrPast(operation)) continue;
        const artifact = this.artifact(component);
        const packageName = artifact.packageName;
        const signerSha256 = artifact.signerSha256;
        const versionName = artifact.versionName;
        if (!packageName || !signerSha256 || (component !== "diagnostics_test" && !versionName)) throw new Error(`The signed ${component} APK metadata is incomplete.`);
        await this.runOperation(operation, stage, stage, prepare, async (recordSent) => {
          await adb.installVerifiedApk(await loadVerifiedArtifact(artifact), {
            packageName, signerSha256,
            ...(versionName ? { versionName } : {})
          }, recordSent);
        }, { sentWithinAction: true });
      }
      if (!this.isOperationSettledOrPast("reboot_after_apps")) {
        await this.runOperation("reboot_after_apps", stage, "awaiting_first_cold_boot", prepare, () => adb.rebootSystem());
      }
      return "awaiting_first_cold_boot";
    } finally { await adb.close().catch(() => undefined); }
  }

  async firstColdBoot(): Promise<BrowserInstallStep> {
    const adb = await WebAdbPsg1.request();
    try {
      const prepare = () => this.assertAdbIdentity(adb, true);
      await this.verifyReconnectCheckpoint("reboot_after_apps", "awaiting_first_cold_boot", prepare);
      await this.runOperation("first_cold_boot", "awaiting_first_cold_boot", "awaiting_second_cold_boot", prepare, () => adb.rebootSystem());
      return "awaiting_second_cold_boot";
    } finally { await adb.close().catch(() => undefined); }
  }

  async finishAfterSecondColdBoot(): Promise<BrowserInstallStep> {
    const adb = await WebAdbPsg1.request();
    try {
      const prepare = () => this.assertAdbIdentity(adb, true);
      await this.verifyReconnectCheckpoint("first_cold_boot", "awaiting_second_cold_boot", prepare);
      await this.runOperation("diagnostics", "awaiting_second_cold_boot", "complete", prepare, () => adb.runDiagnostics(this.context.flashPlan.diagnosticsCommand));
      return "complete";
    } finally { await adb.close().catch(() => undefined); }
  }

  private artifact(component: BrowserInstallArtifact["component"]): BrowserInstallArtifact {
    const artifact = this.artifactByComponent.get(component);
    if (!artifact) throw new Error(`Signed artifact ${component} is unavailable.`);
    return artifact;
  }

  private async assertAdbIdentity(adb: WebAdbPsg1, requireUnlocked = false): Promise<void> {
    const snapshot = await adb.readCompatibility();
    if (snapshot.bootloaderSerialCandidate !== this.context.scan.bootloaderSerial || !snapshot.usbStable) {
      throw new Error("The selected Android interface is not the PSG1 authorized for this installation.");
    }
    if (requireUnlocked && !snapshot.bootloaderUnlocked) {
      throw new Error("The PSG1 did not report an unlocked verified-boot state after the unlock step. No flash command was sent.");
    }
  }

  private async assertFreshStockLockedPreflight(adb: WebAdbPsg1): Promise<void> {
    const snapshot = await adb.readCompatibility();
    assertFreshStockLockedPsg1Preflight(snapshot, this.context.scan, this.context.flashPlan);
  }

  private async assertFastbootIdentityAndMode(fastboot: WebFastbootPsg1, mode: "bootloader" | "fastbootd"): Promise<void> {
    await fastboot.assertIdentity(this.context.scan.bootloaderSerial);
    await fastboot.assertMode(mode);
  }

  private async assertFastbootdCapacity(fastboot: WebFastbootPsg1, systemSize: number): Promise<void> {
    const superPartitionBytes = await fastboot.partitionSize("super");
    assertPsg1FastbootdCapacity(this.context.flashPlan, systemSize, superPartitionBytes);
  }

  private async verifyUnlockOnAndroid(adb: WebAdbPsg1): Promise<void> {
    await this.assertAdbIdentity(adb, true);
    if (!this.isVerified("unlock")) await this.record("awaiting_unlocked_android", "unlock", "verified");
  }

  private async flashVerifiedSystemSegments(
    fastboot: WebFastbootPsg1,
    system: Blob,
    prepare: () => Promise<void>,
    stage: "awaiting_fastbootd_system"
  ): Promise<void> {
    if (this.isPastOperation("flash_system")) return;
    const limit = await fastboot.maxDownloadSize();
    const segments = await createAndroidSparseSegments(system, limit);
    const resume = this.checkpoint?.operation === "flash_system" ? this.checkpoint : undefined;
    if (resume && resume.operationCount !== segments.length) {
      throw new Error("The PSG1 Fastboot download window changed during this installation. Reconnect the same device and request a signed recovery checkpoint.");
    }
    const start = resume
      ? resume.operationState === "verified" ? resume.operationIndex + 1 : resume.operationIndex
      : 0;
    for (let index = start; index < segments.length; index += 1) {
      const segment = segments[index];
      if (!segment) throw new Error("The signed Android sparse segment plan is incomplete.");
      await this.runOperation("flash_system", stage, stage, prepare, (recordSent) => fastboot.flash(this.context.flashPlan.systemPartition, segment, recordSent), {
        operationIndex: index,
        operationCount: segments.length,
        sentWithinAction: true
      });
    }
  }

  private isVerified(operation: string): boolean {
    return this.checkpoint?.operation === operation && this.checkpoint.operationState === "verified";
  }

  private isOperationSettledOrPast(operation: string): boolean {
    if (!this.checkpoint) return false;
    const target = INSTALLATION_OPERATION_ORDER.indexOf(operation);
    const current = INSTALLATION_OPERATION_ORDER.indexOf(this.checkpoint.operation);
    if (target < 0 || current < 0) return false;
    return current > target || (current === target && this.checkpoint.operationState === "verified");
  }

  private isPastOperation(operation: string): boolean {
    if (!this.checkpoint) return false;
    const target = INSTALLATION_OPERATION_ORDER.indexOf(operation);
    const current = INSTALLATION_OPERATION_ORDER.indexOf(this.checkpoint.operation);
    return target >= 0 && current > target;
  }

  /**
   * Reboot commands are idempotent but their successful USB acknowledgement
   * can be lost when the tab dies while the PSG1 changes mode.  We resolve an
   * uncertain reboot only after selecting the same protocol-serial PSG1 in
   * the exact expected Android/Fastboot mode.  Flash, wipe, unlock, and APK
   * checkpoints are deliberately excluded and must be retried or separately
   * verified by their own signed flow.
   */
  private async verifyReconnectCheckpoint(
    operation: string,
    stage: BrowserInstallStep,
    verifyTransport: () => Promise<void>
  ): Promise<void> {
    if (this.checkpoint?.operation !== operation || this.checkpoint.operationState === "verified") return;
    if (!RECONNECT_VERIFIABLE_OPERATIONS.has(operation)) return;
    if (this.checkpoint.operationState === "intent") {
      throw new Error("The previous signed reboot was not sent. Return to its exact checkpoint instead of skipping it.");
    }
    await verifyTransport();
    await this.record(stage, operation, "verified", this.checkpoint.operationIndex, this.checkpoint.operationCount);
  }

  private async runOperation(
    operation: string,
    beforeStage: BrowserInstallStep | "start",
    completedStage: BrowserInstallStep,
    prepare: () => Promise<void>,
    action: (recordSent: () => Promise<void>) => Promise<void>,
    options: { deferVerification?: boolean; operationIndex?: number; operationCount?: number; sentWithinAction?: boolean } = {}
  ): Promise<void> {
    const operationIndex = options.operationIndex ?? 0;
    const operationCount = options.operationCount ?? 1;
    await this.record(beforeStage, operation, "intent", operationIndex, operationCount);
    let sent = false;
    try {
      await prepare();
      const recordSent = async () => {
        if (sent) return;
        await this.record(completedStage, operation, "sent", operationIndex, operationCount);
        sent = true;
      };
      // The durable sent record is written immediately before the one signed
      // device-changing command. Fastboot `download:` and ADB staging are
      // transient, so their action callbacks record `sent` only after upload
      // and immediately before `flash:` / `pm install` changes device state.
      if (!options.sentWithinAction) await recordSent();
      await action(recordSent);
      if (!options.deferVerification) await this.record(completedStage, operation, "verified", operationIndex, operationCount);
    } catch (cause) {
      await this.record(sent ? completedStage : beforeStage, operation, "unknown", operationIndex, operationCount).catch(() => undefined);
      throw cause;
    }
  }

  private async record(
    stage: BrowserInstallStep | "start",
    operation: string,
    operationState: InstallationJournal["operationState"],
    operationIndex = 0,
    operationCount = 1
  ): Promise<void> {
    const journal = { ...this.journalBase, stage, operation, operationState, operationIndex, operationCount, updatedAt: new Date().toISOString() };
    // The local cache preserves the raw Fastboot serial for the next USB
    // identity check. The remote sink receives only redacted/device-bound
    // fields, and is awaited before the following USB command is sent.
    await saveInstallationJournal(journal);
    await this.context.journalSink?.(journal);
    this.checkpoint = {
      stage: journal.stage,
      operation: journal.operation,
      operationState: journal.operationState,
      operationIndex: journal.operationIndex,
      operationCount: journal.operationCount
    };
  }
}

function apkOperation(component: "diagnostics" | "diagnostics_test" | "aurora_store" | "retroarch"): "install_diagnostics" | "install_diagnostics_test" | "install_aurora_store" | "install_retroarch" {
  const operations = {
    diagnostics: "install_diagnostics",
    diagnostics_test: "install_diagnostics_test",
    aurora_store: "install_aurora_store",
    retroarch: "install_retroarch"
  } as const;
  return operations[component];
}

function fastbootPickerUnavailable(cause: unknown): boolean {
  return (typeof DOMException !== "undefined" && cause instanceof DOMException && cause.name === "NotFoundError")
    || (cause instanceof Error && /No PSG1 Fastboot device was selected|Fastboot .*not available|Fastboot interface/iu.test(cause.message));
}

const INSTALLATION_OPERATION_ORDER: readonly string[] = [
  "begin", "unlock", "reboot_for_vbmeta", "flash_vbmeta", "reboot_after_vbmeta", "reboot_for_fastbootd",
  "resize_system", "flash_system", "wipe_userdata", "reboot_after_system", "install_diagnostics",
  "install_diagnostics_test", "install_aurora_store", "install_retroarch", "reboot_after_apps",
  "first_cold_boot", "diagnostics"
];

// These operations do not write a partition or package. Their result can be
// proved by reconnecting the same PSG1 in the signed target mode after a tab
// or cable interruption. Every other uncertain operation remains at its own
// idempotent retry/verification checkpoint.
const RECONNECT_VERIFIABLE_OPERATIONS = new Set<string>([
  "begin",
  "reboot_for_vbmeta",
  "reboot_after_vbmeta",
  "reboot_for_fastbootd",
  "reboot_after_system",
  "reboot_after_apps",
  "first_cold_boot"
]);

export function assertPsg1FlashPlan(plan: Psg1FlashPlan): void {
  if (plan.version !== 1 || plan.target !== "PSG1" || plan.requiredInstallationState !== "stock_locked"
    || plan.unlockCommand !== "fastboot oem at-unlock-vboot" || plan.vbmetaPartition !== "vbmeta"
    || plan.systemPartition !== "system" || plan.systemMode !== "fastbootd" || !plan.resizeLogicalSystem
    || !Number.isSafeInteger(plan.minimumSystemBytes) || plan.minimumSystemBytes < 2_000_000_000 || plan.minimumSystemBytes > 4_294_967_296
    || !Number.isSafeInteger(plan.minimumSuperPartitionBytes) || plan.minimumSuperPartitionBytes < 50_000_000_000 || plan.minimumSuperPartitionBytes > 60_000_000_000
    || plan.minimumSuperPartitionBytes < plan.minimumSystemBytes
    || !plan.wipeUserData || plan.requiredColdBoots !== 2
    || plan.postFlashApkComponents.join(",") !== "diagnostics,diagnostics_test,aurora_store,retroarch"
    || plan.diagnosticsCommand.join("\u0000") !== "am\u0000instrument\u0000-w\u0000com.revivepsg1.diagnostics.test/androidx.test.runner.AndroidJUnitRunner") {
    throw new Error("The signed release contains an unsupported PSG1 flash plan.");
  }
}

/**
 * Re-read the Android state immediately before the API records the irreversible
 * boundary and again before it sends the first reboot. A scan is an observation,
 * not a blank cheque: an OTA, unlock, battery change, or different handset must
 * make the owner run the read-only scan again.
 */
export function assertFreshStockLockedPsg1Preflight(
  snapshot: AdbCompatibilityScan,
  scan: WebCompatibilityScan,
  flashPlan: Psg1FlashPlan
): void {
  if (snapshot.bootloaderSerialCandidate !== scan.bootloaderSerial || !snapshot.usbStable) {
    throw new Error("The selected Android interface is not the PSG1 authorized for this installation.");
  }
  if (snapshot.installationState !== "stock_locked" || snapshot.bootloaderUnlocked) {
    throw new Error("This PSG1 is no longer a stock-locked device. No destructive command was sent.");
  }
  if (!snapshot.recoveryCapable) {
    throw new Error("The PSG1 no longer exposes the required reboot capability. Run the read-only scan again before installation.");
  }
  if (snapshot.batteryPercent < 50 && !snapshot.charging) {
    throw new Error("Charge the PSG1 to at least 50% or keep it charging, then run the read-only scan again.");
  }
  if (snapshot.systemPartitionBytes !== scan.systemPartitionBytes || snapshot.systemPartitionBytes < flashPlan.minimumSystemBytes) {
    throw new Error("The PSG1 system partition layout changed or is too small for this signed release. No destructive command was sent.");
  }
  if (scan.superPartitionBytes < flashPlan.minimumSuperPartitionBytes) {
    throw new Error("The PSG1 super partition is too small for this signed release. No destructive command was sent.");
  }
  const stockIdentityChanged = snapshot.systemBuildFingerprint !== scan.systemBuildFingerprint
    || snapshot.vendorBuildFingerprint !== scan.vendorBuildFingerprint
    || snapshot.systemBuildIncremental !== scan.systemBuildIncremental
    || snapshot.systemBuildType !== scan.systemBuildType
    || snapshot.lineageVersion !== scan.lineageVersion;
  if (stockIdentityChanged) {
    throw new Error("The PSG1 operating-system identity changed after the scan. Run the read-only scan again before installation.");
  }
}

export function assertPsg1FastbootdCapacity(flashPlan: Psg1FlashPlan, systemSize: number, superPartitionBytes: number): void {
  if (!Number.isSafeInteger(systemSize) || systemSize <= 0 || systemSize > flashPlan.minimumSystemBytes) {
    throw new Error("The verified system image exceeds the signed PSG1 partition capacity. No resize or flash command was sent.");
  }
  if (!Number.isSafeInteger(superPartitionBytes) || superPartitionBytes < flashPlan.minimumSuperPartitionBytes) {
    throw new Error("Fastbootd reported a super partition smaller than this signed release requires. No resize or flash command was sent.");
  }
}

export async function recheckStockLockedPsg1BeforeBoundary(scan: WebCompatibilityScan, flashPlan: Psg1FlashPlan): Promise<void> {
  const adb = await WebAdbPsg1.request();
  try {
    assertFreshStockLockedPsg1Preflight(await adb.readCompatibility(), scan, flashPlan);
  } finally {
    await adb.close().catch(() => undefined);
  }
}
