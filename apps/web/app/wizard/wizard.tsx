"use client";

import { useState, useSyncExternalStore } from "react";
import {
  DEVELOPMENT_FIXTURE_COMPATIBILITY,
  DEVELOPMENT_FIXTURE_DEVICE_ID,
  webSessionProofMessage
} from "@revive-psg1/contracts";
import bs58 from "bs58";
import nacl from "tweetnacl";
import { apiUrl } from "../../lib/public-config";
import { assertArtifactCapacity, downloadVerifiedArtifact, type DownloadArtifact } from "../../lib/artifact-cache";
import { verifySignedReleaseDocument } from "../../lib/signed-release";
import { finalizeWebScan, WebAdbPsg1, WebFastbootPsg1, type WebCompatibilityScan } from "../../lib/webusb-psg1";

const API = apiUrl();
const WEB_VERSION = "0.3.0-browser-beta";
const DISCORD_URL = "https://discord.gg/NqE4UeqbEM";

type Stage = "intro" | "adb" | "bootloader" | "fastbootReady" | "fastboot" | "session" | "unsupported" | "betaCode" | "activating" | "ready" | "preparing" | "risk" | "install";
type AdbCompatibilityScan = Awaited<ReturnType<WebAdbPsg1["readCompatibility"]>>;
type Session = { sessionId: string; supported: boolean; browserToken: string; profileId: string | null; expiresAt: string; installationState: WebCompatibilityScan["installationState"] };
type ReleaseArtifact = DownloadArtifact & { kind: "system" | "vbmeta" | "apk" | "recovery"; component: "android_system" | "verified_boot" | "diagnostics" | "diagnostics_test" | "aurora_store" | "retroarch"; delivery: "private"; signerSha256?: string; packageName?: string; versionName?: string };
type Release = { manifest?: { version?: string; artifacts?: ReleaseArtifact[] }; signature?: string; profile?: { id?: string }; profileSignature?: string; downloadUrls?: Record<string, string> };

export function Wizard({ developmentHardwareFixture, compatibilityCheckerOnly, betaBrowserInstaller, destructiveBrowserFlashingValidated }: { developmentHardwareFixture: boolean; compatibilityCheckerOnly: boolean; betaBrowserInstaller: boolean; destructiveBrowserFlashingValidated: boolean }) {
  const [stage, setStage] = useState<Stage>("intro");
  const [scan, setScan] = useState<WebCompatibilityScan | null>(null);
  const [session, setSession] = useState<Session | null>(null);
  const [pendingFastboot, setPendingFastboot] = useState<{ snapshot: AdbCompatibilityScan } | null>(null);
  const [betaCode, setBetaCode] = useState("");
  const [licenseId, setLicenseId] = useState("");
  const [installerToken, setInstallerToken] = useState("");
  const [release, setRelease] = useState<Release | null>(null);
  const [artifactStatus, setArtifactStatus] = useState("");
  const [artifactsReady, setArtifactsReady] = useState(false);
  const [riskAccepted, setRiskAccepted] = useState(false);
  const [confirmation, setConfirmation] = useState("");
  const [error, setError] = useState("");
  const browserReady = useSyncExternalStore(subscribeBrowserCapability, browserCapabilitySnapshot, () => false);
  const betaOpen = betaBrowserInstaller && !compatibilityCheckerOnly;

  async function scanDevice() {
    if (!browserReady || !API) return;
    setError(""); setStage("adb");
    let adb: WebAdbPsg1 | null = null;
    let rebootStarted = false;
    try {
      adb = await WebAdbPsg1.request();
      const snapshot = await adb.readCompatibility();
      if (!snapshot.usbStable) throw new Error("The PSG1 USB connection was not stable enough for a safe scan.");
      setPendingFastboot({ snapshot }); setStage("bootloader"); rebootStarted = true;
      await adb.rebootBootloader(); adb = null; setStage("fastbootReady");
    } catch (cause) {
      setError(messageOf(cause)); setStage(rebootStarted ? "fastbootReady" : "intro");
    } finally {
      if (!rebootStarted) await adb?.close().catch(() => undefined);
    }
  }

  async function continueFastbootScan() {
    if (!pendingFastboot || !API) return;
    setError(""); setStage("fastboot");
    let fastboot: WebFastbootPsg1 | null = null;
    try {
      fastboot = await WebFastbootPsg1.request();
      const completed = await finalizeWebScan(pendingFastboot.snapshot, fastboot);
      setScan(completed); setStage("session");
      const created = await createWebSession(completed);
      setSession(created);
      await fastboot.reboot();
      await fastboot.close().catch(() => undefined); fastboot = null;
      setPendingFastboot(null);
      setStage(created.supported ? (betaOpen ? "betaCode" : "unsupported") : "unsupported");
    } catch (cause) {
      setError(messageOf(cause)); setStage(fastboot ? "intro" : "fastbootReady");
    } finally { await fastboot?.close().catch(() => undefined); }
  }

  async function simulateStockDevice() {
    if (!developmentHardwareFixture || !API) return;
    setError(""); setStage("session");
    try {
      const completed: WebCompatibilityScan = { ...DEVELOPMENT_FIXTURE_COMPATIBILITY, deviceId: DEVELOPMENT_FIXTURE_DEVICE_ID, bootloaderSerial: "DEVELOPMENTFIXTURE" };
      setScan(completed);
      const created = await createWebSession(completed, true);
      setSession(created); setStage(created.supported && betaOpen ? "betaCode" : "unsupported");
    } catch (cause) { setError(messageOf(cause)); setStage("intro"); }
  }

  async function redeemBetaCode() {
    if (!session || !betaCode.trim()) return;
    setError(""); setStage("activating");
    try {
      const access = await request<{ licenseId: string; webInstallerToken: string }>("POST", "/v1/beta/activate", session.browserToken, {
        sessionId: session.sessionId, betaInviteToken: betaCode.trim()
      });
      const authorizedRelease = await request<Release>("GET", "/v1/releases/stable", access.webInstallerToken);
      if (!authorizedRelease.manifest || !authorizedRelease.signature || !authorizedRelease.profile || !authorizedRelease.profileSignature) {
        throw new Error("The beta release response is incomplete.");
      }
      await verifySignedReleaseDocument(authorizedRelease.manifest, authorizedRelease.signature);
      await verifySignedReleaseDocument(authorizedRelease.profile, authorizedRelease.profileSignature);
      setLicenseId(access.licenseId); setInstallerToken(access.webInstallerToken); setRelease(authorizedRelease); setBetaCode(""); setStage("ready");
    } catch (cause) { setError(messageOf(cause)); setStage("betaCode"); }
  }

  async function reviewInstallationReadiness() {
    if (!licenseId || !installerToken || !artifactsReady || confirmation !== "ERASE PSG1" || !riskAccepted) return;
    setError(""); setStage("install");
    try {
      await request("POST", `/v1/licenses/${licenseId}/installation-started`, installerToken, {
        termsVersion: "browser-beta-1", irreversibleRiskAcknowledged: true, confirmation: "ERASE PSG1"
      });
    } catch (cause) {
      setError(messageOf(cause)); setStage("risk");
    }
  }

  async function prepareArtifacts() {
    if (!release?.manifest?.artifacts || !release.downloadUrls) return;
    setError(""); setArtifactStatus(""); setStage("preparing");
    try {
      const artifacts = requiredBetaArtifacts(release.manifest.artifacts);
      await assertArtifactCapacity(artifacts);
      for (const artifact of artifacts) {
        const url = release.downloadUrls[artifact.objectKey];
        if (!url) throw new Error(`The signed URL for ${artifact.id} is unavailable.`);
        await downloadVerifiedArtifact(artifact, url, (progress) => {
          setArtifactStatus(`${progress.phase === "download" ? "Downloading" : "Verifying"} ${progress.artifactId}: ${Math.floor(progress.downloaded / 1024 / 1024)} / ${Math.ceil(progress.total / 1024 / 1024)} MiB`);
        });
      }
      setArtifactsReady(true); setArtifactStatus("All signed beta artifacts are verified in persistent browser storage."); setStage("risk");
    } catch (cause) { setError(messageOf(cause)); setStage("ready"); }
  }

  return <section className="wizard-card">
    <div className="wizard-heading"><span className="section-label">{betaOpen ? "DISCORD BROWSER BETA" : "COMPATIBILITY CHECK"}</span><h1>{betaOpen ? "Revive your PSG1 in browser." : "Check your PSG1."}</h1><p>{betaOpen ? "Private, supervised beta only. Installation wipes the device, leaves the bootloader unlocked, and may be irreversible." : "This public scan is read-only. It does not unlock, wipe, flash, or bind your PSG1."}</p></div>
    {scan && <div className="scan-summary"><span>PSG1 detected</span><span>{scan.model || scan.product}</span><span>Battery {scan.batteryPercent}%</span><span>CPU ↔ Fastboot identity ✓</span></div>}
    {stage === "intro" && <div className="wizard-step"><Step number={1} title="Read-only hardware scan" /><p>Connect the powered-on PSG1 with USB debugging authorized. Chrome or Edge will ask you to select it again after rebooting to Fastboot.</p><button className="button primary wide" disabled={!browserReady || !API} onClick={scanDevice}>Connect and scan PSG1</button><small>Use Chrome or Edge on macOS or Windows with a data-capable cable.</small>{developmentHardwareFixture && <button className="button ghost wide" disabled={!API} onClick={simulateStockDevice}>Simulate stock PSG1</button>}</div>}
    {stage === "adb" && <Progress title="Reading the PSG1 identity and safety preflight…" />}
    {stage === "bootloader" && <Progress title="Restarting the PSG1 into Fastboot…" />}
    {stage === "fastbootReady" && <div className="wizard-step"><Step number={2} title="Select Fastboot PSG1" /><p>The handheld restarted. Select its Fastboot interface in the next browser prompt.</p><button className="button primary wide" onClick={continueFastbootScan}>Select Fastboot PSG1</button></div>}
    {stage === "fastboot" && <Progress title="Cross-checking the immutable PSG1 identity…" />}
    {stage === "session" && <Progress title="Checking the signed compatibility profile…" />}
    {stage === "unsupported" && <div className="blocked"><strong>This PSG1 is not eligible for browser beta installation.</strong><p>It was returned to Android without any modification. Beta access requires a supported, stock locked PSG1 and a Discord-issued code.</p></div>}
    {stage === "betaCode" && <div className="wizard-step"><Step number={3} title="Redeem beta tester code" /><p>This is a free, supervised beta. Join Discord, open a ticket, and ask for your one-time code. The first compatible PSG1 that redeems it becomes its permanent beta device.</p><a className="button ghost wide" href={DISCORD_URL} target="_blank" rel="noreferrer">Join Discord and open a ticket ↗</a><label className="field">One-time beta code<input value={betaCode} onChange={(event) => setBetaCode(event.target.value)} placeholder="rpb_…" autoComplete="off" spellCheck={false} /></label><button className="button primary wide" disabled={!betaCode.trim()} onClick={redeemBetaCode}>Activate free beta access</button><small>Do not share your code. It cannot be moved to another PSG1 after redemption.</small></div>}
    {stage === "activating" && <Progress title="Binding this code to your PSG1 and authorizing the signed beta release…" />}
    {stage === "ready" && <div className="success"><strong>✓ Beta release authorized</strong><p>Release {release?.manifest?.version ?? "authorized"} is signed for this PSG1. Aurora Store and RetroArch are included as verified post-flash APKs.</p><button className="button primary wide" onClick={prepareArtifacts}>Download and verify beta artifacts</button></div>}
    {stage === "preparing" && <Progress title={artifactStatus || "Preparing signed beta artifacts in persistent browser storage…"} />}
    {stage === "risk" && <div className="wizard-step"><Step number={4} title="Irreversible installation" /><div className="warning"><strong>No echOS recovery image is provided.</strong><p>This process erases all data, leaves the bootloader unlocked, may make restoration impossible, and can leave the device unusable. Keep your Discord support ticket open.</p></div><p className="success">✓ {artifactStatus || "Signed beta artifacts verified"}</p><label className="checkbox"><input type="checkbox" checked={riskAccepted} onChange={(event) => setRiskAccepted(event.target.checked)} /> I understand and accept the irreversible beta risks.</label><label className="field">Type <b>ERASE PSG1</b> to start<input value={confirmation} onChange={(event) => setConfirmation(event.target.value)} autoComplete="off" /></label><button className="button danger wide" disabled={!artifactsReady || !riskAccepted || confirmation !== "ERASE PSG1"} onClick={reviewInstallationReadiness}>Review installation readiness</button></div>}
    {stage === "install" && <div className="pending"><strong>Destructive boundary recorded.</strong><p>{destructiveBrowserFlashingValidated ? "This release is enabled for its validated supervised flow." : "No Fastboot command has been sent. This exact release still requires a signed production diagnostics pair and a complete stock-PSG1 validation run before beta flashing can be opened."}</p><small>Do not unlock, flash, or use generic Fastboot commands outside the supervised beta procedure.</small></div>}
    {error && <p className="error" role="alert">{error}</p>}
  </section>;
}

function Step({ number, title }: { number: number; title: string }) { return <h2><span>{number}</span>{title}</h2>; }
function Progress({ title }: { title: string }) { return <div className="pending"><strong>{title}</strong><div className="scanner"><i /><span>Keep the cable connected.</span></div></div>; }

async function createWebSession(scan: WebCompatibilityScan, developmentFixture = false): Promise<Session> {
  const keyPair = nacl.sign.keyPair();
  const pairingPublicKey = bs58.encode(keyPair.publicKey);
  const requestNonce = base64Url(crypto.getRandomValues(new Uint8Array(32)));
  const createdAt = new Date().toISOString();
  const proofInput = { deviceId: scan.deviceId, pairingPublicKey, appVersion: WEB_VERSION, requestNonce, createdAt };
  const pairingProof = bs58.encode(nacl.sign.detached(new TextEncoder().encode(webSessionProofMessage(proofInput)), keyPair.secretKey));
  return request<Session>("POST", "/v1/web/sessions", "", {
    ...proofInput, pairingProof, hostOs: "web", ...(developmentFixture ? { developmentFixture: true } : {}),
    compatibility: {
      product: scan.product, model: scan.model, board: scan.board, hardware: scan.hardware,
      buildFingerprint: scan.buildFingerprint, buildIncremental: scan.buildIncremental,
      systemBuildFingerprint: scan.systemBuildFingerprint, vendorBuildFingerprint: scan.vendorBuildFingerprint,
      systemBuildIncremental: scan.systemBuildIncremental, systemBuildType: scan.systemBuildType,
      lineageVersion: scan.lineageVersion, bootloaderUnlocked: scan.bootloaderUnlocked,
      installationState: scan.installationState, androidApiLevel: scan.androidApiLevel, vendorApiLevel: scan.vendorApiLevel,
      batteryPercent: scan.batteryPercent, charging: scan.charging, serialVerified: scan.serialVerified,
      immutableSerialVerified: scan.immutableSerialVerified, fastbootUsbDescriptorVerified: scan.fastbootUsbDescriptorVerified,
      usbStable: scan.usbStable, recoveryCapable: scan.recoveryCapable, hostBytesAvailable: scan.hostBytesAvailable,
      systemPartitionBytes: scan.systemPartitionBytes, superPartitionBytes: scan.superPartitionBytes
    }
  });
}

async function request<T = unknown>(method: "GET" | "POST", path: string, token: string, body?: unknown): Promise<T> {
  if (!API) throw new Error("The secure API is not configured.");
  const response = await fetch(`${API}${path}`, { method, headers: { ...(body === undefined ? {} : { "content-type": "application/json" }), ...(token ? { authorization: `Bearer ${token}` } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const value = await response.json().catch(() => ({})) as { code?: string; message?: string };
  if (!response.ok) throw new Error(ERROR_MESSAGES[value.code ?? ""] ?? value.message ?? value.code ?? "Request failed");
  return value as T;
}

const ERROR_MESSAGES: Record<string, string> = {
  BETA_INSTALLER_CLOSED: "The browser beta installer is not open yet.", BETA_CODE_REQUIRED: "A Discord beta code is required.",
  BETA_INVITE_INVALID_OR_USED: "That beta code is invalid, expired, or already bound to another PSG1.", BETA_COHORT_FULL: "The current beta cohort is full.",
  DESTRUCTIVE_TEST_MODE_BLOCKED: "Destructive installation is blocked for modified or simulated devices.", UNSUPPORTED_FIRMWARE: "This firmware is not supported. No modification was performed."
};
function messageOf(cause: unknown) { return cause instanceof Error ? cause.message : "Request failed"; }
function requiredBetaArtifacts(artifacts: ReleaseArtifact[]): ReleaseArtifact[] {
  const required = ["android_system", "verified_boot", "diagnostics", "diagnostics_test", "aurora_store", "retroarch"] as const;
  const selected = required.map((component) => artifacts.find((artifact) => artifact.delivery === "private" && artifact.component === component));
  if (selected.some((artifact) => !artifact)) throw new Error("The signed beta release is missing a required system, vbmeta, diagnostics pair, Aurora Store, or RetroArch artifact.");
  return selected as ReleaseArtifact[];
}
function base64Url(bytes: Uint8Array) { return btoa(String.fromCharCode(...bytes)).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", ""); }
function subscribeBrowserCapability(onStoreChange: () => void) { window.addEventListener("load", onStoreChange); return () => window.removeEventListener("load", onStoreChange); }
function browserCapabilitySnapshot() { return typeof navigator !== "undefined" && WebAdbPsg1.supported() && WebFastbootPsg1.supported(); }
