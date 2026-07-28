import { loadVerifiedArtifact, saveInstallationJournal, type DownloadArtifact, type InstallationJournal } from "./artifact-cache";
import { WebAdbPsg1, WebFastbootPsg1, type WebCompatibilityScan } from "./webusb-psg1";

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
  artifacts: BrowserInstallArtifact[];
};

/**
 * The only destructive browser operation path. Every method requires a fresh
 * user-selected USB device after a reboot and rechecks its immutable serial.
 */
export class BrowserInstaller {
  private readonly artifactByComponent: Map<BrowserInstallArtifact["component"], BrowserInstallArtifact>;
  private readonly journalBase: Omit<InstallationJournal, "stage" | "updatedAt">;

  constructor(private readonly context: Context) {
    if (!context.scan.bootloaderSerial || !context.profileId || !context.releaseVersion) {
      throw new Error("The authorized installation context is incomplete.");
    }
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
  }

  async begin(): Promise<BrowserInstallStep> {
    const adb = await WebAdbPsg1.request();
    try {
      await this.assertAdbIdentity(adb);
      await adb.rebootBootloader();
      await this.record("awaiting_bootloader_unlock");
      return "awaiting_bootloader_unlock";
    } finally { await adb.close().catch(() => undefined); }
  }

  async unlock(): Promise<BrowserInstallStep> {
    const fastboot = await WebFastbootPsg1.request();
    try {
      await fastboot.assertIdentity(this.context.scan.bootloaderSerial);
      await fastboot.assertMode("bootloader");
      await fastboot.unlockVerifiedBoot();
      await this.record("awaiting_unlocked_android");
      return "awaiting_unlocked_android";
    } finally { await fastboot.close().catch(() => undefined); }
  }

  async rebootForVbmeta(): Promise<BrowserInstallStep> {
    const adb = await WebAdbPsg1.request();
    try {
      await this.assertAdbIdentity(adb);
      await adb.rebootBootloader();
      await this.record("awaiting_vbmeta_bootloader");
      return "awaiting_vbmeta_bootloader";
    } finally { await adb.close().catch(() => undefined); }
  }

  async flashVbmeta(): Promise<BrowserInstallStep> {
    const fastboot = await WebFastbootPsg1.request();
    try {
      await fastboot.assertIdentity(this.context.scan.bootloaderSerial);
      await fastboot.assertMode("bootloader");
      await fastboot.flash("vbmeta", await loadVerifiedArtifact(this.artifact("verified_boot")));
      await fastboot.reboot();
      await this.record("awaiting_system_android");
      return "awaiting_system_android";
    } finally { await fastboot.close().catch(() => undefined); }
  }

  async rebootForFastbootd(): Promise<BrowserInstallStep> {
    const adb = await WebAdbPsg1.request();
    try {
      await this.assertAdbIdentity(adb);
      await adb.rebootFastboot();
      await this.record("awaiting_fastbootd_system");
      return "awaiting_fastbootd_system";
    } finally { await adb.close().catch(() => undefined); }
  }

  async flashSystem(): Promise<BrowserInstallStep> {
    const fastboot = await WebFastbootPsg1.request();
    try {
      await fastboot.assertIdentity(this.context.scan.bootloaderSerial);
      await fastboot.assertMode("fastbootd");
      const system = await loadVerifiedArtifact(this.artifact("android_system"));
      await fastboot.resizeLogicalSystem(system.size);
      await fastboot.flashSparseSystem(system);
      await fastboot.wipeUserData();
      await fastboot.reboot();
      await this.record("awaiting_postflash_android");
      return "awaiting_postflash_android";
    } finally { await fastboot.close().catch(() => undefined); }
  }

  async installAppsAndReboot(): Promise<BrowserInstallStep> {
    const adb = await WebAdbPsg1.request();
    try {
      await this.assertAdbIdentity(adb);
      for (const component of ["diagnostics", "diagnostics_test", "aurora_store", "retroarch"] as const) {
        const artifact = this.artifact(component);
        if (!artifact.packageName || !artifact.signerSha256 || (component !== "diagnostics_test" && !artifact.versionName)) throw new Error(`The signed ${component} APK metadata is incomplete.`);
        await adb.installVerifiedApk(await loadVerifiedArtifact(artifact), {
          packageName: artifact.packageName, signerSha256: artifact.signerSha256,
          ...(artifact.versionName ? { versionName: artifact.versionName } : {})
        });
      }
      await adb.rebootSystem();
      await this.record("awaiting_first_cold_boot");
      return "awaiting_first_cold_boot";
    } finally { await adb.close().catch(() => undefined); }
  }

  async firstColdBoot(): Promise<BrowserInstallStep> {
    const adb = await WebAdbPsg1.request();
    try {
      await this.assertAdbIdentity(adb);
      await adb.rebootSystem();
      await this.record("awaiting_second_cold_boot");
      return "awaiting_second_cold_boot";
    } finally { await adb.close().catch(() => undefined); }
  }

  async finishAfterSecondColdBoot(): Promise<BrowserInstallStep> {
    const adb = await WebAdbPsg1.request();
    try {
      await this.assertAdbIdentity(adb);
      await adb.runDiagnostics();
      await this.record("complete");
      return "complete";
    } finally { await adb.close().catch(() => undefined); }
  }

  private artifact(component: BrowserInstallArtifact["component"]): BrowserInstallArtifact {
    const artifact = this.artifactByComponent.get(component);
    if (!artifact) throw new Error(`Signed artifact ${component} is unavailable.`);
    return artifact;
  }

  private async assertAdbIdentity(adb: WebAdbPsg1): Promise<void> {
    const snapshot = await adb.readCompatibility();
    if (snapshot.bootloaderSerialCandidate !== this.context.scan.bootloaderSerial || !snapshot.usbStable) {
      throw new Error("The selected Android interface is not the PSG1 authorized for this beta installation.");
    }
  }

  private async record(stage: BrowserInstallStep): Promise<void> {
    await saveInstallationJournal({ ...this.journalBase, stage, updatedAt: new Date().toISOString() });
  }
}
