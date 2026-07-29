"use client";

import { useEffect, useState } from "react";
import {
  DEVELOPMENT_FIXTURE_COMPATIBILITY,
  DEVELOPMENT_FIXTURE_DEVICE_ID,
  webSessionProofMessage
} from "@revive-psg1/contracts";
import bs58 from "bs58";
import nacl from "tweetnacl";
import { apiUrl } from "../../lib/public-config";
import { assertArtifactCapacity, downloadVerifiedArtifact, loadInstallationJournal, type DownloadArtifact } from "../../lib/artifact-cache";
import { BrowserInstaller, type BrowserInstallArtifact, type BrowserInstallStep } from "../../lib/browser-installer";
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
type InstallUiStep = "start" | BrowserInstallStep;

export function Wizard({ developmentHardwareFixture, compatibilityCheckerOnly, betaBrowserInstaller, destructiveBrowserFlashingValidated, hardwarePilotEnabled }: { developmentHardwareFixture: boolean; compatibilityCheckerOnly: boolean; betaBrowserInstaller: boolean; destructiveBrowserFlashingValidated: boolean; hardwarePilotEnabled: boolean }) {
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
  const [installStep, setInstallStep] = useState<InstallUiStep>("start");
  const [installStatus, setInstallStatus] = useState("");
  const [error, setError] = useState("");
  // WebUSB can only be inspected in the browser. Do this after hydration:
  // subscribing to `load` alone is racy because React may attach the
  // subscription after the page's load event has already fired.
  const [browserReady, setBrowserReady] = useState(false);
  useEffect(() => { setBrowserReady(browserCapabilitySnapshot()); }, []);
  const betaOpen = betaBrowserInstaller && !compatibilityCheckerOnly;
  const destructiveBrowserFlashingEnabled = destructiveBrowserFlashingValidated || hardwarePilotEnabled;
  const hardwarePilot = hardwarePilotEnabled && !destructiveBrowserFlashingValidated;

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
      const resumableStep = await matchingJournalStep(authorizedRelease, scan);
      setLicenseId(access.licenseId); setInstallerToken(access.webInstallerToken); setRelease(authorizedRelease); setBetaCode("");
      if (resumableStep) { setInstallStep(resumableStep); setInstallStatus("Recovered the verified local installation journal."); setStage("install"); }
      else setStage("ready");
    } catch (cause) { setError(messageOf(cause)); setStage("betaCode"); }
  }

  async function resumeBetaInstallation() {
    if (!session) return;
    setError(""); setStage("activating");
    try {
      const access = await request<{ licenseId: string; webInstallerToken: string }>("POST", "/v1/beta/resume", session.browserToken, { sessionId: session.sessionId });
      const authorizedRelease = await request<Release>("GET", "/v1/releases/stable", access.webInstallerToken);
      if (!authorizedRelease.manifest || !authorizedRelease.signature || !authorizedRelease.profile || !authorizedRelease.profileSignature) {
        throw new Error("The beta release response is incomplete.");
      }
      await verifySignedReleaseDocument(authorizedRelease.manifest, authorizedRelease.signature);
      await verifySignedReleaseDocument(authorizedRelease.profile, authorizedRelease.profileSignature);
      const resumableStep = await matchingJournalStep(authorizedRelease, scan);
      setLicenseId(access.licenseId); setInstallerToken(access.webInstallerToken); setRelease(authorizedRelease);
      if (resumableStep) { setInstallStep(resumableStep); setInstallStatus("Recovered the verified local installation journal."); setStage("install"); }
      else setStage("ready");
    } catch (cause) { setError(messageOf(cause)); setStage("betaCode"); }
  }

  async function reviewInstallationReadiness() {
    if (!licenseId || !installerToken || !artifactsReady || confirmation !== "ERASE PSG1" || !riskAccepted) return;
    setError("");
    try {
      await request("POST", `/v1/licenses/${licenseId}/installation-started`, installerToken, {
        termsVersion: "browser-beta-1", irreversibleRiskAcknowledged: true, confirmation: "ERASE PSG1"
      });
      setInstallStep("start"); setStage("install");
    } catch (cause) {
      setError(messageOf(cause)); setStage("risk");
    }
  }

  async function continueInstallation() {
    if (!destructiveBrowserFlashingEnabled || !scan || !release?.manifest?.artifacts || !release.manifest.version || !release.profile?.id) return;
    setError("");
    try {
      const installer = new BrowserInstaller({
        scan, profileId: release.profile.id, releaseVersion: release.manifest.version,
        artifacts: requiredBetaArtifacts(release.manifest.artifacts) as BrowserInstallArtifact[]
      });
      setInstallStatus(installStep === "start" ? "Requesting Android access…" : "Checking the selected PSG1 and continuing the signed installation…");
      const next = installStep === "start" ? await installer.begin()
        : installStep === "awaiting_bootloader_unlock" ? await installer.unlock()
          : installStep === "awaiting_unlocked_android" ? await installer.rebootForVbmeta()
            : installStep === "awaiting_vbmeta_bootloader" ? await installer.flashVbmeta()
              : installStep === "awaiting_system_android" ? await installer.rebootForFastbootd()
                : installStep === "awaiting_fastbootd_system" ? await installer.flashSystem()
                  : installStep === "awaiting_postflash_android" ? await installer.installAppsAndReboot()
                    : installStep === "awaiting_first_cold_boot" ? await installer.firstColdBoot()
                      : installStep === "awaiting_second_cold_boot" ? await installer.finishAfterSecondColdBoot()
                        : "complete";
      setInstallStep(next); setInstallStatus(next === "complete" ? "Two cold boots and diagnostics passed." : "Step recorded. Follow the connection instruction below.");
    } catch (cause) { setError(messageOf(cause)); setInstallStatus("Installation paused safely. Reconnect the same PSG1 and retry this step."); }
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
    <div className="wizard-heading"><span className="section-label">{hardwarePilot ? "HARDWARE VALIDATION PILOT" : betaOpen ? "DISCORD BROWSER BETA" : "COMPATIBILITY CHECK"}</span><h1>{betaOpen ? "Revive your PSG1 in browser." : "Check your PSG1."}</h1><p>{hardwarePilot ? "One supervised stock-PSG1 hardware-validation pilot only. Installation wipes the device, leaves the bootloader unlocked, and may be irreversible." : betaOpen ? "Private, supervised beta only. Installation wipes the device, leaves the bootloader unlocked, and may be irreversible." : "This public scan is read-only. It does not unlock, wipe, flash, or bind your PSG1."}</p></div>
    {scan && <div className="scan-summary"><span>PSG1 detected</span><span>{scan.model || scan.product}</span><span>Battery {scan.batteryPercent}%</span><span>CPU ↔ Fastboot identity ✓</span></div>}
    {stage === "intro" && <div className="wizard-step"><Step number={1} title="Read-only hardware scan" /><p>Connect the powered-on PSG1 with USB debugging authorized. Chrome or Edge will ask you to select it again after rebooting to Fastboot.</p><button className="button primary wide" disabled={!browserReady || !API} onClick={scanDevice}>Connect and scan PSG1</button><small>Use Chrome or Edge on macOS or Windows with a data-capable cable.</small>{developmentHardwareFixture && <button className="button ghost wide" disabled={!API} onClick={simulateStockDevice}>Simulate stock PSG1</button>}</div>}
    {stage === "adb" && <Progress title="Reading the PSG1 identity and safety preflight…" />}
    {stage === "bootloader" && <Progress title="Restarting the PSG1 into Fastboot…" />}
    {stage === "fastbootReady" && <div className="wizard-step"><Step number={2} title="Select Fastboot PSG1" /><p>The handheld restarted. Select its Fastboot interface in the next browser prompt.</p><button className="button primary wide" onClick={continueFastbootScan}>Select Fastboot PSG1</button></div>}
    {stage === "fastboot" && <Progress title="Cross-checking the immutable PSG1 identity…" />}
    {stage === "session" && <Progress title="Checking the signed compatibility profile…" />}
    {stage === "unsupported" && <div className="blocked"><strong>This PSG1 is not eligible for browser beta installation.</strong><p>It was returned to Android without any modification. Beta access requires a supported, stock locked PSG1 and a Discord-issued code.</p></div>}
    {stage === "betaCode" && <div className="wizard-step"><Step number={3} title={hardwarePilot ? "Redeem hardware-pilot code" : "Redeem beta tester code"} /><p>{hardwarePilot ? "This is the single supervised hardware-validation pilot, not the normal beta cohort. Join Discord, open a ticket, and use the pilot code only while support is present." : "This is a free, supervised beta. Join Discord, open a ticket, and ask for your one-time code. The first compatible PSG1 that redeems it becomes its permanent beta device."}</p><a className="button ghost wide" href={DISCORD_URL} target="_blank" rel="noreferrer">Join Discord and open a ticket ↗</a><label className="field">One-time beta code<input value={betaCode} onChange={(event) => setBetaCode(event.target.value)} placeholder="rpb_…" autoComplete="off" spellCheck={false} /></label><button className="button primary wide" disabled={!betaCode.trim()} onClick={redeemBetaCode}>Activate free beta access</button><button className="button ghost wide" onClick={resumeBetaInstallation}>Resume this PSG1&apos;s beta</button><small>Do not share your code. It cannot be moved to another PSG1 after redemption.</small></div>}
    {stage === "activating" && <Progress title="Binding this code to your PSG1 and authorizing the signed beta release…" />}
    {stage === "ready" && <div className="success"><strong>✓ Beta release authorized</strong><p>Release {release?.manifest?.version ?? "authorized"} is signed for this PSG1. Aurora Store and RetroArch are included as verified post-flash APKs.</p><button className="button primary wide" onClick={prepareArtifacts}>Download and verify beta artifacts</button></div>}
    {stage === "preparing" && <Progress title={artifactStatus || "Preparing signed beta artifacts in persistent browser storage…"} />}
    {stage === "risk" && <div className="wizard-step"><Step number={4} title="Irreversible installation" /><div className="warning"><strong>No echOS recovery image is provided.</strong><p>This process erases all data, leaves the bootloader unlocked, may make restoration impossible, and can leave the device unusable. Keep your Discord support ticket open.</p></div><p className="success">✓ {artifactStatus || "Signed beta artifacts verified"}</p><label className="checkbox"><input type="checkbox" checked={riskAccepted} onChange={(event) => setRiskAccepted(event.target.checked)} /> I understand and accept the irreversible beta risks.</label><label className="field">Type <b>ERASE PSG1</b> to start<input value={confirmation} onChange={(event) => setConfirmation(event.target.value)} autoComplete="off" /></label><button className="button danger wide" disabled={!artifactsReady || !riskAccepted || confirmation !== "ERASE PSG1"} onClick={reviewInstallationReadiness}>Review installation readiness</button></div>}
    {stage === "install" && <div className="pending"><strong>{installStep === "complete" ? "✓ Beta installation complete" : "Destructive boundary recorded."}</strong><p>{destructiveBrowserFlashingEnabled ? installInstruction(installStep) : "No Fastboot command has been sent. This exact release still requires a signed production diagnostics pair and a complete stock-PSG1 validation run before beta flashing can be opened."}</p>{destructiveBrowserFlashingEnabled && installStep !== "complete" && <button className="button danger wide" onClick={continueInstallation}>{installButton(installStep)}</button>}<small>{installStatus || "Do not unlock, flash, or use generic Fastboot commands outside the supervised beta procedure."}</small></div>}
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
  BETA_ENTITLEMENT_NOT_FOUND: "This PSG1 does not have an active beta entitlement yet.",
  DESTRUCTIVE_TEST_MODE_BLOCKED: "Destructive installation is blocked for modified or simulated devices.", UNSUPPORTED_FIRMWARE: "This firmware is not supported. No modification was performed."
};
function messageOf(cause: unknown) { return cause instanceof Error ? cause.message : "Request failed"; }
function requiredBetaArtifacts(artifacts: ReleaseArtifact[]): ReleaseArtifact[] {
  const required = ["android_system", "verified_boot", "diagnostics", "diagnostics_test", "aurora_store", "retroarch"] as const;
  const selected = required.map((component) => artifacts.find((artifact) => artifact.delivery === "private" && artifact.component === component));
  if (selected.some((artifact) => !artifact)) throw new Error("The signed beta release is missing a required system, vbmeta, diagnostics pair, Aurora Store, or RetroArch artifact.");
  return selected as ReleaseArtifact[];
}
async function matchingJournalStep(release: Release, scan: WebCompatibilityScan | null): Promise<BrowserInstallStep | null> {
  if (!scan || !release.manifest?.version || !release.profile?.id || !release.manifest.artifacts) return null;
  const journal = await loadInstallationJournal();
  const validSteps = new Set<BrowserInstallStep>([
    "awaiting_bootloader_unlock", "awaiting_unlocked_android", "awaiting_vbmeta_bootloader", "awaiting_system_android",
    "awaiting_fastbootd_system", "awaiting_postflash_android", "awaiting_first_cold_boot", "awaiting_second_cold_boot", "complete"
  ]);
  if (!journal || !validSteps.has(journal.stage as BrowserInstallStep)
    || journal.deviceId !== scan.deviceId || journal.bootloaderSerial !== scan.bootloaderSerial
    || journal.profileId !== release.profile.id || journal.releaseVersion !== release.manifest.version) return null;
  const expected = Object.fromEntries(requiredBetaArtifacts(release.manifest.artifacts).map((artifact) => [artifact.id, artifact.sha256]));
  return Object.entries(expected).every(([id, hash]) => journal.artifactHashes[id] === hash) ? journal.stage as BrowserInstallStep : null;
}
function installInstruction(step: InstallUiStep): string {
  const instructions: Record<InstallUiStep, string> = {
    start: "Reconnect the powered-on stock PSG1 through ADB. The browser will reboot it to bootloader Fastboot.",
    awaiting_bootloader_unlock: "Select the same PSG1 in bootloader Fastboot. Confirm the unlock prompt on the handheld if it appears.",
    awaiting_unlocked_android: "Wait for Android after the unlock wipe, authorize USB debugging again, then reconnect the same PSG1.",
    awaiting_vbmeta_bootloader: "Select the same PSG1 in bootloader Fastboot to flash the verified vbmeta artifact.",
    awaiting_system_android: "Wait for Android, authorize USB debugging again, then reconnect the same PSG1 to enter Fastbootd.",
    awaiting_fastbootd_system: "Select the same PSG1 in Fastbootd. The verified sparse system image will be flashed and userdata wiped.",
    awaiting_postflash_android: "Wait for the flashed system to boot, complete its first setup, authorize USB debugging, then reconnect the same PSG1 to install the verified APKs.",
    awaiting_first_cold_boot: "Reconnect the same PSG1 after its first cold boot. It will reboot once more.",
    awaiting_second_cold_boot: "Reconnect the same PSG1 after its second cold boot to run the signed diagnostics.",
    complete: "Aurora Store, RetroArch, diagnostics, and two cold boots were verified. Keep your Discord ticket open for handoff."
  };
  return instructions[step];
}
function installButton(step: InstallUiStep): string {
  return step === "start" ? "Start signed installation" : step === "complete" ? "Complete" : "Select same PSG1 and continue";
}
function base64Url(bytes: Uint8Array) { return btoa(String.fromCharCode(...bytes)).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", ""); }
function browserCapabilitySnapshot() { return typeof navigator !== "undefined" && WebAdbPsg1.supported() && WebFastbootPsg1.supported(); }
