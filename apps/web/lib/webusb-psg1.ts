import { Adb, AdbDaemonTransport } from "@yume-chan/adb";
import AdbWebCredentialStore from "@yume-chan/adb-credential-web";
import { AdbDaemonWebUsbDeviceManager } from "@yume-chan/adb-daemon-webusb";
import { createAndroidSparseSegments } from "./android-sparse";

export const ROCKCHIP_VENDOR_ID = 0x2207;
export const FASTBOOT_INTERFACE = Object.freeze({ classCode: 0xff, subclassCode: 0x42, protocolCode: 0x03 });
const DEVICE_ID_DOMAIN = "revive-psg1:v1";
export type InstallationState = "stock_locked" | "stock_unlocked" | "already_modified" | "development_fixture";

export type WebCompatibilityScan = {
  deviceId: string;
  product: string;
  model: string;
  board: string;
  hardware: string;
  buildFingerprint: string;
  buildIncremental: string;
  systemBuildFingerprint: string;
  vendorBuildFingerprint: string;
  systemBuildIncremental: string;
  systemBuildType: string;
  lineageVersion: string;
  bootloaderUnlocked: boolean;
  installationState: InstallationState;
  androidApiLevel: number;
  vendorApiLevel: number;
  batteryPercent: number;
  charging: boolean;
  serialVerified: boolean;
  immutableSerialVerified: boolean;
  fastbootUsbDescriptorVerified: boolean;
  usbStable: boolean;
  recoveryCapable: boolean;
  hostBytesAvailable: number;
  systemPartitionBytes: number;
  superPartitionBytes: number;
};

export type AdbCompatibilityScan = Omit<WebCompatibilityScan,
  "deviceId" | "superPartitionBytes" | "serialVerified" | "immutableSerialVerified" | "fastbootUsbDescriptorVerified"
> & { bootloaderSerialCandidate: string };

export class WebAdbPsg1 {
  readonly adb: Adb;
  readonly normalizedSerial: string;

  private constructor(adb: Adb, normalizedSerial: string) {
    this.adb = adb;
    this.normalizedSerial = normalizedSerial;
  }

  static supported(): boolean {
    return typeof navigator !== "undefined" && Boolean(navigator.usb) && window.isSecureContext;
  }

  static async request(): Promise<WebAdbPsg1> {
    const manager = AdbDaemonWebUsbDeviceManager.BROWSER;
    if (!manager || !WebAdbPsg1.supported()) {
      throw new Error("WebUSB requires desktop Chrome or Edge on a secure HTTPS page.");
    }
    const device = await manager.requestDevice({ filters: [{ vendorId: ROCKCHIP_VENDOR_ID }] });
    if (!device) throw new Error("No PSG1 ADB interface was selected.");
    const usbSerial = normalizeSerial(device.raw.serialNumber ?? device.serial);
    if (!usbSerial) throw new Error("The PSG1 USB descriptor did not expose a serial number.");
    const connection = await device.connect();
    const transport = await AdbDaemonTransport.authenticate({
      serial: device.serial,
      connection,
      credentialStore: new AdbWebCredentialStore("Revive PSG1 Web")
    });
    const adb = new Adb(transport);
    // A reboot intentionally tears down the WebUSB transport. The ADB library
    // exposes that event as a rejected promise, so attach a handler immediately
    // while command-level calls continue to report unexpected failures.
    void adb.disconnected.catch(() => undefined);
    const adbSerial = normalizeSerial(adb.serial);
    if (!adbSerial || adbSerial !== usbSerial) {
      await adb.close();
      throw new Error("ADB and USB descriptor serials do not match.");
    }
    return new WebAdbPsg1(adb, adbSerial);
  }

  async readCompatibility(): Promise<AdbCompatibilityScan> {
    const [product, model, board, hardware, buildFingerprint, buildIncremental, systemBuildFingerprint, vendorBuildFingerprint, systemBuildIncremental, systemBuildType, lineageVersion, flashLocked, verifiedBootState, cpuInfo, androidApi, vendorApi, battery, recovery, systemStorage, storage] = await Promise.all([
      firstProp(this.adb, ["ro.product.vendor.device", "ro.product.odm.device", "ro.product.device"]),
      firstProp(this.adb, ["ro.product.vendor.model", "ro.product.odm.model", "ro.product.model"]),
      boardIdentity(this.adb),
      firstProp(this.adb, ["ro.soc.model", "ro.hardware", "ro.boot.hardware"]),
      this.adb.getProp("ro.build.fingerprint"),
      this.adb.getProp("ro.build.version.incremental"),
      this.adb.getProp("ro.system.build.fingerprint"),
      this.adb.getProp("ro.vendor.build.fingerprint"),
      this.adb.getProp("ro.system.build.version.incremental"),
      this.adb.getProp("ro.system.build.type"),
      this.adb.getProp("ro.lineage.version"),
      this.adb.getProp("ro.boot.flash.locked"),
      this.adb.getProp("ro.boot.verifiedbootstate"),
      this.adb.subprocess.noneProtocol.spawnWaitText(["cat", "/proc/cpuinfo"]),
      this.adb.getProp("ro.build.version.sdk"),
      this.adb.getProp("ro.vendor.build.version.sdk"),
      this.adb.subprocess.noneProtocol.spawnWaitText(["dumpsys", "battery"]),
      this.adb.subprocess.noneProtocol.spawnWaitText(["sh", "-c", "if command -v reboot >/dev/null 2>&1 || [ -x /system/bin/toybox ] || [ -e /dev/block/by-name/recovery ]; then echo yes; fi"]),
      this.adb.subprocess.noneProtocol.spawnWaitText(["df", "-k", "/system"]),
      navigator.storage.estimate()
    ]);
    const batteryPercent = Math.min(100, parseBatteryNumber(battery, "level"));
    const status = parseBatteryNumber(battery, "status");
    const serialAgain = normalizeSerial(this.adb.serial);
    const bootloaderSerialCandidate = parseCpuInfoSerial(cpuInfo);
    if (!bootloaderSerialCandidate) {
      throw new Error("Android did not expose the immutable Rockchip CPU serial required for safe cross-mode identity verification.");
    }
    const bootloaderUnlocked = flashLocked.trim() === "0" || verifiedBootState.trim().toLowerCase() === "orange";
    const identity = {
      systemBuildFingerprint: systemBuildFingerprint.trim() || buildFingerprint.trim(),
      vendorBuildFingerprint: vendorBuildFingerprint.trim() || buildFingerprint.trim(),
      systemBuildIncremental: systemBuildIncremental.trim() || buildIncremental.trim(),
      systemBuildType: systemBuildType.trim() || "unknown",
      lineageVersion: lineageVersion.trim(),
      bootloaderUnlocked
    };
    return {
      product: product.trim(), model: model.trim(), board: board.trim(), hardware: hardware.trim(),
      buildFingerprint: buildFingerprint.trim(), buildIncremental: buildIncremental.trim(),
      ...identity,
      installationState: classifyInstallationState(identity),
      bootloaderSerialCandidate,
      androidApiLevel: parseInteger(androidApi), vendorApiLevel: parseInteger(vendorApi),
      batteryPercent, charging: status === 2 || status === 5,
      usbStable: serialAgain === this.normalizedSerial,
      recoveryCapable: recovery.trim() === "yes",
      hostBytesAvailable: Math.max(0, (storage.quota ?? 0) - (storage.usage ?? 0)),
      systemPartitionBytes: parseDfKilobytes(systemStorage)
    };
  }

  async rebootBootloader(): Promise<void> {
    try {
      await this.adb.power.bootloader();
    } catch (cause) {
      if (!isExpectedUsbDisconnect(cause)) throw cause;
    }
  }

  async rebootFastboot(): Promise<void> {
    try {
      await this.adb.power.fastboot();
    } catch (cause) {
      if (!isExpectedUsbDisconnect(cause)) throw cause;
    }
  }

  async close(): Promise<void> {
    await this.adb.close();
  }
}

async function firstProp(adb: Adb, names: string[]): Promise<string> {
  for (const name of names) {
    const value = (await adb.getProp(name)).trim();
    if (value) return value;
  }
  return "";
}

async function boardIdentity(adb: Adb): Promise<string> {
  const [soc, revision, fallback] = await Promise.all([
    firstProp(adb, ["ro.soc.model", "ro.board.platform"]),
    firstProp(adb, ["ro.vendor.sdkversion", "ro.tyzc.version"]),
    firstProp(adb, ["ro.product.board", "ro.boot.hardware"])
  ]);
  return [soc, revision].filter(Boolean).join(" ") || fallback;
}

export class WebFastbootPsg1 {
  readonly raw: USBDevice;
  readonly normalizedUsbSerial: string;
  private readonly inEndpoint: number;
  private readonly outEndpoint: number;
  private readonly interfaceNumber: number;

  private constructor(raw: USBDevice, interfaceNumber: number, inEndpoint: number, outEndpoint: number) {
    this.raw = raw;
    this.interfaceNumber = interfaceNumber;
    this.inEndpoint = inEndpoint;
    this.outEndpoint = outEndpoint;
    this.normalizedUsbSerial = normalizeSerial(raw.serialNumber ?? "");
  }

  static supported(): boolean {
    return typeof navigator !== "undefined" && Boolean(navigator.usb) && window.isSecureContext;
  }

  static async request(): Promise<WebFastbootPsg1> {
    if (!WebFastbootPsg1.supported()) throw new Error("Fastboot over WebUSB requires desktop Chrome or Edge over HTTPS.");
    const raw = await navigator.usb.requestDevice({ filters: [{ vendorId: ROCKCHIP_VENDOR_ID, ...FASTBOOT_INTERFACE }] });
    await raw.open();
    if (!raw.configuration) await raw.selectConfiguration(raw.configurations[0]?.configurationValue ?? 1);
    const match = findFastbootInterface(raw.configuration);
    if (!match) {
      await raw.close();
      throw new Error("The selected USB device does not expose the PSG1 Fastboot bulk interface.");
    }
    await raw.claimInterface(match.interfaceNumber);
    return new WebFastbootPsg1(raw, match.interfaceNumber, match.inEndpoint, match.outEndpoint);
  }

  async getVariable(name: string): Promise<string> {
    return parseFastbootVariable(name, await this.command(`getvar:${name}`));
  }

  async maxDownloadSize(): Promise<number> {
    return parseFastbootSize(await this.getVariable("max-download-size"));
  }

  async unlockVerifiedBoot(): Promise<void> {
    await this.command("oem at-unlock-vboot");
  }

  async flash(partition: "vbmeta" | "system", payload: Blob): Promise<void> {
    await this.download(payload);
    await this.command(`flash:${partition}`);
  }

  /** Flash a verified raw ext4 system image through Fastbootd's download window. */
  async flashSparseSystem(image: Blob, onProgress?: (completed: number, total: number) => void): Promise<void> {
    const limit = await this.maxDownloadSize();
    const segments = await createAndroidSparseSegments(image, limit);
    for (let index = 0; index < segments.length; index += 1) {
      const segment = segments[index];
      if (!segment) throw new Error("Android sparse segment plan is incomplete.");
      await this.download(segment);
      await this.command("flash:system");
      onProgress?.(index + 1, segments.length);
    }
  }

  async resizeLogicalSystem(size: number): Promise<void> {
    if (!Number.isSafeInteger(size) || size <= 0) throw new Error("System partition size is invalid.");
    await this.command(`resize-logical-partition:system:${size}`);
  }

  async wipeUserData(): Promise<void> {
    await this.command("erase:userdata");
  }

  async download(payload: Blob): Promise<void> {
    if (!Number.isSafeInteger(payload.size) || payload.size <= 0 || payload.size > 0xffffffff) {
      throw new Error("Fastboot payload size is invalid.");
    }
    const limit = await this.maxDownloadSize();
    if (!limit || payload.size > limit) {
      throw new Error(`The signed artifact is ${payload.size} bytes, but this PSG1 only accepts ${limit || 0} bytes per Fastboot download. A tested sparse-image release is required; no flash was attempted.`);
    }
    await this.sendCommand(`download:${payload.size.toString(16).padStart(8, "0")}`);
    const data = await this.readResponse();
    if (data.status !== "DATA") throw new Error("Fastboot did not accept the download request.");
    const accepted = Number.parseInt(data.payload.replace(/^0x/iu, ""), 16);
    if (!Number.isSafeInteger(accepted) || accepted !== payload.size) {
      throw new Error("Fastboot accepted an unexpected download size.");
    }
    const reader = payload.stream().getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!value?.byteLength) continue;
        const sent = await this.raw.transferOut(this.outEndpoint, value);
        if (sent.status !== "ok" || sent.bytesWritten !== value.byteLength) throw new Error("Fastboot artifact transfer failed.");
      }
    } finally {
      reader.releaseLock();
    }
    const complete = await this.readTerminal();
    if (complete.status !== "OKAY") throw new Error("Fastboot did not confirm the artifact download.");
  }

  async reboot(): Promise<void> {
    await this.command("reboot");
  }

  async close(): Promise<void> {
    try { await this.raw.releaseInterface(this.interfaceNumber); } finally { await this.raw.close(); }
  }

  private async command(command: string): Promise<string> {
    await this.sendCommand(command);
    const result = await this.readTerminal();
    return result.payload;
  }

  private async sendCommand(command: string): Promise<void> {
    const encoded = new TextEncoder().encode(command);
    if (encoded.byteLength > 64 || !/^[\x20-\x7e]+$/u.test(command)) throw new Error("Fastboot command is invalid.");
    const sent = await this.raw.transferOut(this.outEndpoint, encoded);
    if (sent.status !== "ok" || sent.bytesWritten !== encoded.byteLength) throw new Error("Fastboot command transfer failed.");
  }

  private async readResponse(): Promise<ReturnType<typeof parseFastbootResponse>> {
    const response = await this.raw.transferIn(this.inEndpoint, 64);
    if (response.status !== "ok" || !response.data) throw new Error("Fastboot response transfer failed.");
    return parseFastbootResponse(new Uint8Array(response.data.buffer, response.data.byteOffset, response.data.byteLength));
  }

  private async readTerminal(): Promise<{ status: "OKAY"; payload: string }> {
    const info: string[] = [];
    for (let attempt = 0; attempt < 512; attempt += 1) {
      const parsed = await this.readResponse();
      if (parsed.status === "INFO") {
        if (parsed.payload) info.push(parsed.payload);
        continue;
      }
      if (parsed.status === "FAIL") throw new Error(`Fastboot rejected the command: ${parsed.payload || info.at(-1) || "unknown error"}`);
      if (parsed.status === "DATA") throw new Error("Unexpected Fastboot data phase.");
      return { status: "OKAY", payload: parsed.payload || info.join("\n") };
    }
    throw new Error("Fastboot produced too many informational responses.");
  }
}

export async function finalizeWebScan(
  adbScan: AdbCompatibilityScan,
  fastboot: WebFastbootPsg1
): Promise<WebCompatibilityScan> {
  const fastbootSerial = normalizeSerial((await fastboot.getVariable("serialno")) || fastboot.normalizedUsbSerial);
  const usbSerial = fastboot.normalizedUsbSerial;
  const bootloaderSerialCandidate = normalizeSerial(adbScan.bootloaderSerialCandidate);
  if (!fastbootSerial || fastbootSerial !== bootloaderSerialCandidate) {
    throw new Error(`The Rockchip CPU and Fastboot protocol serials do not match (CPU length ${bootloaderSerialCandidate.length}; Fastboot length ${fastbootSerial.length}). No access was activated and no device modification was attempted.`);
  }
  const fastbootUsbDescriptorVerified = Boolean(usbSerial) && usbSerial === fastbootSerial;
  if (!adbScan.systemPartitionBytes) throw new Error("Android did not report a valid mounted system size.");
  const superPartitionBytes = parseFastbootSize(await fastboot.getVariable("partition-size:super"));
  if (!superPartitionBytes) throw new Error("Fastboot did not report a valid super partition size.");
  // `at-unlock-vboot` unlocks Android Verified Boot on the PSG1, while the
  // generic Fastboot `unlocked` variable continues to report the separate
  // bootloader flashing lock as `no`. The read-only ro.boot values originate
  // from the boot chain and are authoritative for the operation we perform.
  const bootloaderUnlocked = adbScan.bootloaderUnlocked;
  const { bootloaderSerialCandidate: _bootloaderSerialCandidate, ...verifiedAdbScan } = adbScan;
  return {
    ...verifiedAdbScan,
    // Reaching Fastboot through this scan proves that the ADB reboot service
    // accepted a boot-mode transition even when the GSI has no reboot binary.
    recoveryCapable: true,
    bootloaderUnlocked,
    installationState: classifyInstallationState({ ...adbScan, bootloaderUnlocked }),
    deviceId: await deviceIdForSerial(fastbootSerial),
    superPartitionBytes,
    serialVerified: true,
    immutableSerialVerified: true,
    fastbootUsbDescriptorVerified
  };
}

export function classifyInstallationState(identity: Pick<WebCompatibilityScan,
  "systemBuildFingerprint" | "vendorBuildFingerprint" | "systemBuildIncremental" | "systemBuildType" | "lineageVersion" | "bootloaderUnlocked"
>): Exclude<InstallationState, "development_fixture"> {
  const systemIdentity = `${identity.systemBuildFingerprint}\n${identity.systemBuildIncremental}\n${identity.lineageVersion}`.toLowerCase();
  const modifiedSystem = Boolean(identity.lineageVersion.trim())
    || /(?:^|[\/_-])(lineage|aosp|generic|gsi)(?:[\/_:-]|$)/iu.test(systemIdentity);
  if (modifiedSystem) return "already_modified";
  return identity.bootloaderUnlocked ? "stock_unlocked" : "stock_locked";
}

export function parseFastbootUnlocked(value: string): boolean | null {
  const normalized = value.trim().toLowerCase();
  if (["yes", "true", "1", "unlocked"].includes(normalized)) return true;
  if (["no", "false", "0", "locked"].includes(normalized)) return false;
  return null;
}

export function isExpectedUsbDisconnect(cause: unknown): boolean {
  return cause instanceof Error
    && /(?:device was disconnected|transfer(?:in|out).*disconnected|networkerror|connection.*closed)/iu.test(cause.message);
}

export function normalizeSerial(value: string): string {
  return value.trim().replace(/[-_\s]/gu, "").toUpperCase();
}

export function parseCpuInfoSerial(value: string): string {
  return normalizeSerial(value.match(/^\s*Serial\s*:\s*([A-Za-z0-9_-]+)\s*$/imu)?.[1] ?? "");
}

export async function deviceIdForSerial(serial: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${DEVICE_ID_DOMAIN}${normalizeSerial(serial)}`));
  return [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, "0")).join("");
}

export function parseFastbootResponse(bytes: Uint8Array): { status: "OKAY" | "FAIL" | "INFO" | "DATA"; payload: string } {
  const text = new TextDecoder().decode(bytes).replace(/\0+$/u, "");
  const status = text.slice(0, 4);
  if (!(["OKAY", "FAIL", "INFO", "DATA"] as const).includes(status as "OKAY")) throw new Error("Fastboot returned an unknown status.");
  return { status: status as "OKAY" | "FAIL" | "INFO" | "DATA", payload: text.slice(4).trim() };
}

export function parseFastbootSize(value: string): number {
  const trimmed = value.trim();
  const parsed = /^0x[0-9a-f]+$/iu.test(trimmed) ? Number.parseInt(trimmed.slice(2), 16) : Number.parseInt(trimmed, 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : 0;
}

export function parseDfKilobytes(value: string): number {
  const fields = value.split(/\r?\n/gu).map((line) => line.trim()).filter(Boolean).at(-1)?.split(/\s+/gu) ?? [];
  const blocks = Number.parseInt(fields[1] ?? "", 10);
  const bytes = blocks * 1024;
  return Number.isSafeInteger(bytes) && bytes > 0 ? bytes : 0;
}

export function parseFastbootVariable(name: string, value: string): string {
  const escapedName = name.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const lines = value.split(/\r?\n/gu)
    .map((line) => line.trim().replace(/^\(bootloader\)\s*/iu, ""))
    .filter(Boolean);
  const labeled = lines.map((line) => line.match(new RegExp(`^${escapedName}\\s*:\\s*(.+)$`, "iu"))?.[1]).find(Boolean);
  return (labeled ?? lines[0] ?? "").trim();
}

function findFastbootInterface(configuration: USBConfiguration | null): { interfaceNumber: number; inEndpoint: number; outEndpoint: number } | null {
  for (const interface_ of configuration?.interfaces ?? []) {
    for (const alternate of interface_.alternates) {
      if (alternate.interfaceClass !== FASTBOOT_INTERFACE.classCode || alternate.interfaceSubclass !== FASTBOOT_INTERFACE.subclassCode || alternate.interfaceProtocol !== FASTBOOT_INTERFACE.protocolCode) continue;
      const input = alternate.endpoints.find((endpoint) => endpoint.type === "bulk" && endpoint.direction === "in");
      const output = alternate.endpoints.find((endpoint) => endpoint.type === "bulk" && endpoint.direction === "out");
      if (input && output) return { interfaceNumber: interface_.interfaceNumber, inEndpoint: input.endpointNumber, outEndpoint: output.endpointNumber };
    }
  }
  return null;
}

function parseBatteryNumber(value: string, key: string): number {
  return Number.parseInt(value.match(new RegExp(`^\\s*${key}:\\s*(\\d+)`, "mu"))?.[1] ?? "0", 10) || 0;
}

function parseInteger(value: string): number {
  const parsed = Number.parseInt(value.trim(), 10);
  return Number.isFinite(parsed) ? parsed : 0;
}
