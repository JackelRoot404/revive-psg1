"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import {
  DEVELOPMENT_FIXTURE_COMPATIBILITY,
  DEVELOPMENT_FIXTURE_DEVICE_ID,
  compatibilityProfileSchema,
  type Psg1FlashPlan,
  releaseManifestSchema,
  webSessionProofMessage
} from "@revive-psg1/contracts";
import bs58 from "bs58";
import nacl from "tweetnacl";
import { apiUrl } from "../../lib/public-config";
import { assertArtifactCapacity, clearPersistentInstallationResume, downloadVerifiedArtifact, loadPersistentInstallationResume, savePersistentInstallationResume, type DownloadArtifact, type InstallationJournal, type PersistentInstallationResume } from "../../lib/artifact-cache";
import { BrowserInstaller, recheckStockLockedPsg1BeforeBoundary, type BrowserInstallArtifact, type BrowserInstallStep } from "../../lib/browser-installer";
import { canonicalSignedDocumentSha256, verifySignedReleaseDocument } from "../../lib/signed-release";
import { deviceIdForSerial, finalizeWebScan, WebAdbPsg1, WebFastbootPsg1, type WebCompatibilityScan } from "../../lib/webusb-psg1";

const API = apiUrl();
const WEB_VERSION = "0.3.0-browser";
const COMMUNITY_URL = "https://github.com/biccsdev/revive-psg1/issues";

type Stage = "intro" | "adb" | "bootloader" | "fastbootWaiting" | "fastbootReady" | "fastboot" | "session" | "scanOutcome" | "publicActivate" | "betaCode" | "activating" | "ready" | "preparing" | "risk" | "install";
type AdbCompatibilityScan = Awaited<ReturnType<WebAdbPsg1["readCompatibility"]>>;
type InstallationState = WebCompatibilityScan["installationState"];
type InstallerMode = "scan_only" | "private_beta" | "public";
type DecisionPart = { status?: string; blockers?: string[]; installationState?: string; canInstall?: boolean };
type SessionDecision = {
  profile?: string | DecisionPart;
  compatibility?: DecisionPart;
  preflight?: string | DecisionPart;
  deviceState?: InstallationState | DecisionPart;
  blockers?: string[];
  installerMode?: InstallerMode;
  canInstall?: boolean;
  availability?: DecisionPart;
};
// The API keeps its legacy session fields while adding this decision object.
// Accept the slightly more detailed form used by older deployments too, but
// fail closed whenever the install decision is absent or unrecognised.
type Session = {
  sessionId: string;
  supported?: boolean;
  browserToken: string;
  profileId?: string | null;
  expiresAt: string;
  installationState?: InstallationState;
  installerMode?: InstallerMode;
  canInstall?: boolean;
  decision?: SessionDecision;
};
// This is deliberately session-scoped rather than an account/recovery token.
// It gives a crashed/restored browser tab enough context to ask the API for an
// exact resume while the server session is still valid. The API revalidates
// the token, device binding, release, artifact map, and current USB mode; a
// value edited in browser storage cannot authorize a Fastboot command.
type StoredResumeContext = {
  savedAt: string;
  session: Session;
  scan: WebCompatibilityScan;
};
const STORED_RESUME_CONTEXT_KEY = "revive-psg1:browser-resume:v1";
type ResolvedDecision = {
  profile: "matched" | "not_recognized" | "ambiguous" | "unknown";
  preflight: "passed" | "blocked" | "not_run" | "unknown";
  deviceState: InstallationState | "unknown";
  blockers: string[];
  installerMode: InstallerMode | "unknown";
  canInstall: boolean;
};
type ScanOutcome = "public" | "private_beta" | "unsupported" | "preflight" | "already_modified" | "stock_unlocked" | "development_fixture" | "scan_only" | "public_paused" | "unavailable";
type ReleaseArtifact = DownloadArtifact & { kind: "system" | "vbmeta" | "apk" | "recovery"; component: "android_system" | "verified_boot" | "diagnostics" | "diagnostics_test" | "aurora_store" | "retroarch"; delivery: "private" | "public"; signerSha256?: string; packageName?: string; versionName?: string };
type SignedWindowsFastbootDriver = {
  packageUrl: string;
  installerSha256: string;
  catalogSha256: string;
  authenticodeSigner: string;
  hardwareIds: string[];
  interfaceGuid: string;
};
type PublicDriverEnvelope = { manifest?: unknown; signature?: string };
type Release = { manifest?: { releaseId?: string; version?: string; artifacts?: ReleaseArtifact[]; flashPlan?: Psg1FlashPlan }; signature?: string; profile?: { id?: string }; profileSignature?: string; downloadUrls?: Record<string, string> };
type InstallerAccess = {
  licenseId: string;
  webInstallerToken: string;
  orderId?: string;
  expiresInSeconds?: number;
  alreadyLicensed?: boolean;
  activation?: "public_free" | "public_resume";
  resume?: boolean;
  resumeCredential?: string;
  resumeCredentialExpiresAt?: string;
};
type InstallationBoundaryResponse = {
  modificationStartedAt: string;
  resumed?: boolean;
  resumeCredential: string;
  resumeCredentialExpiresAt: string;
};
type RemoteInstallationJournal = Omit<InstallationJournal, "bootloaderSerial">;
type JournalResume = {
  step: InstallUiStep;
  operation: InstallationJournal["operation"];
  operationState: InstallationJournal["operationState"];
  operationIndex: number;
  operationCount: number;
};
type InstallUiStep = "start" | BrowserInstallStep;
type CompatibilityReportAction = {
  consented: boolean;
  submitting: boolean;
  submitted: boolean;
  onConsentChange: (consented: boolean) => void;
  onSubmit: () => void;
};
type InstallationResumeAction = { onResume: () => void };
type WizardProps = {
  developmentHardwareFixture: boolean;
};

export function Wizard({ developmentHardwareFixture }: WizardProps) {
  const [stage, setStage] = useState<Stage>("intro");
  const [scan, setScan] = useState<WebCompatibilityScan | null>(null);
  const [session, setSession] = useState<Session | null>(null);
  const [pendingFastboot, setPendingFastboot] = useState<{ snapshot: AdbCompatibilityScan } | null>(null);
  const [betaCode, setBetaCode] = useState("");
  const [licenseId, setLicenseId] = useState("");
  const [installerToken, setInstallerToken] = useState("");
  const [release, setRelease] = useState<Release | null>(null);
  const [signedWindowsDriver, setSignedWindowsDriver] = useState<SignedWindowsFastbootDriver | null>(null);
  const [artifactStatus, setArtifactStatus] = useState("");
  const [artifactsReady, setArtifactsReady] = useState(false);
  const [riskAccepted, setRiskAccepted] = useState(false);
  const [confirmation, setConfirmation] = useState("");
  const [installStep, setInstallStep] = useState<InstallUiStep>("start");
  const [resumeCheckpoint, setResumeCheckpoint] = useState<Pick<InstallationJournal, "stage" | "operation" | "operationState" | "operationIndex" | "operationCount"> | null>(null);
  const [installStatus, setInstallStatus] = useState("");
  const [resumeAuthorized, setResumeAuthorized] = useState(false);
  const [error, setError] = useState("");
  const [reportConsented, setReportConsented] = useState(false);
  const [reportStatus, setReportStatus] = useState<"idle" | "submitting" | "submitted">("idle");
  const [storedResume, setStoredResume] = useState<StoredResumeContext | null>(null);
  const [durableResume, setDurableResume] = useState<PersistentInstallationResume | null>(null);
  // WebUSB can only be inspected in the browser. Do this after hydration:
  // subscribing to `load` alone is racy because React may attach the
  // subscription after the page's load event has already fired.
  const [browserReady, setBrowserReady] = useState(false);
  useEffect(() => {
    const timer = window.setTimeout(() => {
      setBrowserReady(browserCapabilitySnapshot());
      setStoredResume(loadStoredResumeContext());
      void loadPersistentInstallationResume().then(setDurableResume);
    }, 0);
    return () => window.clearTimeout(timer);
  }, []);
  const decision = session ? resolveDecision(session, scan) : null;
  const outcome = session && decision ? scanOutcome(decision, scan) : null;
  const privateBeta = decision?.installerMode === "private_beta";
  const simulatedFixture = Boolean(developmentHardwareFixture && scan?.installationState === "development_fixture");
  const browserInstallationAllowed = canBeginBrowserInstallation(session, scan, installerToken)
    || (resumeAuthorized && Boolean(installerToken) && isSafeAuthorizedResume(session, scan));
  const compatibilityReportAllowed = Boolean(session && scan && decision && outcome && canOfferCompatibilityReport(session, scan, decision, outcome));
  const publicResumeAllowed = Boolean(session && scan && outcome && canAttemptPublicResume(session, scan));
  const needsWindowsFastbootSetup = error.includes("Windows Fastboot driver setup is required");
  useEffect(() => {
    if (!needsWindowsFastbootSetup || signedWindowsDriver || !API) return;
    let cancelled = false;
    void request<PublicDriverEnvelope>("GET", "/v1/public/windows-fastboot-driver", "")
      .then(verifiedWindowsFastbootDriver)
      .then((driver) => { if (!cancelled) setSignedWindowsDriver(driver); })
      // The original Fastboot error and the documented safe setup path remain
      // useful if a public signed driver envelope is not available yet.
      .catch(() => undefined);
    return () => { cancelled = true; };
  }, [needsWindowsFastbootSetup, signedWindowsDriver]);

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
      await adb.rebootBootloader();
      adb = null;
      // ADB disconnects before Windows has necessarily enumerated the new
      // Fastboot interface. Waiting here prevents an immediately opened
      // WebUSB chooser from appearing empty on slower hosts.
      setStage("fastbootWaiting");
      await waitForFastbootEnumeration();
      setStage("fastbootReady");
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
      resetCompatibilityReport();
      setResumeAuthorized(false);
      setSession(created);
      rememberResumeContext(created, completed);
      await fastboot.reboot();
      await fastboot.close().catch(() => undefined); fastboot = null;
      setPendingFastboot(null);
      setStage(stageForSession(created, completed));
    } catch (cause) {
      setError(messageOf(cause, { fastbootPicker: true })); setStage("fastbootReady");
    } finally { await fastboot?.close().catch(() => undefined); }
  }

  async function simulateStockDevice() {
    if (!developmentHardwareFixture || !API) return;
    setError(""); setStage("session");
    try {
      const completed: WebCompatibilityScan = { ...DEVELOPMENT_FIXTURE_COMPATIBILITY, deviceId: DEVELOPMENT_FIXTURE_DEVICE_ID, bootloaderSerial: "DEVELOPMENTFIXTURE" };
      setScan(completed);
      const created = await createWebSession(completed, true);
      resetCompatibilityReport();
      setResumeAuthorized(false);
      setSession(created); rememberResumeContext(created, completed);
      const simulatedDecision = resolveDecision(created, completed);
      setStage(simulatedDecision.installerMode === "private_beta" ? "betaCode" : stageForSession(created, completed));
    } catch (cause) { setError(messageOf(cause)); setStage("intro"); }
  }

  function authorizeSimulatedPilot() {
    if (!simulatedFixture || !privateBeta) return;
    setError("");
    setArtifactsReady(false);
    setArtifactStatus("");
    setRiskAccepted(false);
    setConfirmation("");
    setInstallStep("start");
    setInstallStatus("");
    setStage("ready");
  }

  async function redeemBetaCode() {
    if (!session || !betaCode.trim() || !canUsePrivateBeta(session, scan)) return;
    setError(""); setStage("activating");
    try {
      const access = await request<InstallerAccess>("POST", "/v1/beta/activate", session.browserToken, {
        sessionId: session.sessionId, betaInviteToken: betaCode.trim()
      });
      await authorizeRelease(access);
      setBetaCode("");
    } catch (cause) { setError(messageOf(cause)); setStage("betaCode"); }
  }

  async function resumeBetaInstallation() {
    if (!session || !canUsePrivateBeta(session, scan)) return;
    setError(""); setStage("activating");
    try {
      const access = await request<InstallerAccess>("POST", "/v1/beta/resume", session.browserToken, { sessionId: session.sessionId });
      await authorizeRelease(access);
    } catch (cause) { setError(messageOf(cause)); setStage("betaCode"); }
  }

  async function activatePublicAccess() {
    if (!session || !canUsePublicInstaller(session, scan)) return;
    setError(""); setStage("activating");
    try {
      const access = await request<InstallerAccess>("POST", "/v1/public/activate", session.browserToken, { sessionId: session.sessionId });
      await authorizeRelease(access);
    } catch (cause) { setError(messageOf(cause)); setStage("publicActivate"); }
  }

  async function resumePublicInstallation() {
    if (!session || !scan || !canAttemptPublicResume(session, scan)) return;
    setError(""); setStage("activating");
    try {
      const access = await request<InstallerAccess>("POST", "/v1/public/resume", session.browserToken, { sessionId: session.sessionId });
      await authorizeRelease({ ...access, resume: true });
    } catch (cause) {
      setError(messageOf(cause)); setStage("scanOutcome");
    }
  }

  async function resumeStoredInstallation() {
    if (!storedResume || !API) return;
    setError(""); setStage("activating");
    try {
      // Restore only the short-lived scan context. The API still requires the
      // active browser token and the installer reselects/rechecks the PSG1 in
      // its current Android or Fastboot mode before it sends any command.
      setScan(storedResume.scan);
      setSession(storedResume.session);
      const access = await request<InstallerAccess>("POST", "/v1/public/resume", storedResume.session.browserToken, {
        sessionId: storedResume.session.sessionId
      });
      await authorizeRelease({ ...access, resume: true }, storedResume.scan);
    } catch (cause) {
      setError(messageOf(cause)); setStage("intro");
    }
  }

  async function resumeFastbootOnlyInstallation() {
    if (!durableResume || !API) return;
    setError(""); setStage("activating");
    let fastboot: WebFastbootPsg1 | null = null;
    try {
      fastboot = await WebFastbootPsg1.request();
      const selectedDeviceId = await deviceIdForSerial(await fastboot.getVariable("serialno"));
      if (selectedDeviceId !== durableResume.deviceId) {
        throw new Error("The selected Fastboot interface is not the PSG1 with the saved signed installation.");
      }
      const access = await request<InstallerAccess>("POST", "/v1/public/fastboot-resume", "", {
        deviceId: selectedDeviceId,
        resumeCredential: durableResume.resumeCredential
      });
      // The server intentionally keeps the opaque credential stable through
      // Fastboot-only resume. Replacing it before this tab can durably write
      // the response would create a crash window with no recovery secret.
      setScan(durableResume.scan); setSession(null);
      await fastboot.close().catch(() => undefined); fastboot = null;
      await authorizeRelease({ ...access, resume: true }, durableResume.scan);
    } catch (cause) {
      setError(messageOf(cause, { fastbootPicker: true })); setStage("intro");
    } finally { await fastboot?.close().catch(() => undefined); }
  }

  function resetCompatibilityReport() {
    setReportConsented(false);
    setReportStatus("idle");
  }

  function rememberResumeContext(nextSession: Session, nextScan: WebCompatibilityScan) {
    const context: StoredResumeContext = { savedAt: new Date().toISOString(), session: nextSession, scan: nextScan };
    saveStoredResumeContext(context);
    setStoredResume(context);
  }

  async function submitCompatibilityReport() {
    if (!session || !scan || !decision || !outcome || !reportConsented || reportStatus === "submitting"
      || !canOfferCompatibilityReport(session, scan, decision, outcome)) return;
    setError(""); setReportStatus("submitting");
    try {
      await request("POST", "/v1/compatibility-reports", session.browserToken, {
        sessionId: session.sessionId,
        profileCandidate: buildRedactedCompatibilityReport(scan),
        consentToNotify: true
      });
      setReportStatus("submitted");
    } catch (cause) {
      setError(messageOf(cause)); setReportStatus("idle");
    }
  }

  async function authorizeRelease(access: InstallerAccess, scanOverride?: WebCompatibilityScan) {
    const authorizedRelease = await request<Release>("GET", "/v1/releases/stable", access.webInstallerToken);
    if (!authorizedRelease.manifest || !authorizedRelease.manifest.flashPlan || !authorizedRelease.signature || !authorizedRelease.profile || !authorizedRelease.profileSignature) {
      throw new Error("The authorized release response is incomplete.");
    }
    await verifySignedReleaseDocument(authorizedRelease.manifest, authorizedRelease.signature);
    await verifySignedReleaseDocument(authorizedRelease.profile, authorizedRelease.profileSignature);
    const parsedManifest = releaseManifestSchema.safeParse({ ...authorizedRelease.manifest, signature: authorizedRelease.signature });
    const parsedProfile = compatibilityProfileSchema.safeParse({ ...authorizedRelease.profile, signature: authorizedRelease.profileSignature });
    if (!parsedManifest.success || !parsedProfile.success || !parsedManifest.data.profileIds.includes(parsedProfile.data.id)) {
      throw new Error("The signed release does not contain the exact required PSG1 artifact roles and profile binding.");
    }
    if (!installerVersionSatisfies(WEB_VERSION, parsedManifest.data.minimumInstallerVersion)) {
      throw new Error("This browser installer is older than the signed release requires. Refresh or update the installer before continuing.");
    }
    const remoteJournal = await loadRemoteInstallationJournal(access.licenseId, access.webInstallerToken);
    const resumable = access.resume ? await matchingJournalStep(authorizedRelease, scanOverride ?? scan, remoteJournal, true) : null;
    if (access.resume && !resumable) throw new Error("The signed installation checkpoint does not match this PSG1. No Fastboot command was sent.");
    setLicenseId(access.licenseId); setInstallerToken(access.webInstallerToken); setRelease(authorizedRelease);
    setSignedWindowsDriver(parsedManifest.data.publicEvidence?.windowsFastbootDriver ?? null);
    setArtifactsReady(false); setArtifactStatus(""); setRiskAccepted(false); setConfirmation("");
    setResumeAuthorized(Boolean(access.resume));
    if (resumable) {
      setInstallStep(resumable.step);
      setResumeCheckpoint({
        stage: resumable.step,
        operation: resumable.operation,
        operationState: resumable.operationState,
        operationIndex: resumable.operationIndex,
        operationCount: resumable.operationCount
      });
      setInstallStatus(resumable.operationState === "verified"
        ? "Recovered the verified device-bound installation checkpoint. Download hashes will be checked again before continuing."
        : "The last USB operation was interrupted before confirmation. The same signed checkpoint will recheck the PSG1 before any retry.");
    } else {
      setInstallStep("start"); setResumeCheckpoint(null); setInstallStatus("");
    }
    // A normal web-session resume can bootstrap the same-origin durable
    // Fastboot-only record. Keep the current tab usable if browser storage is
    // unavailable; the user can still continue this authenticated session,
    // but the UI should make the reduced recovery guarantee explicit.
    const resumeScan = scanOverride ?? scan;
    if (access.resume && access.resumeCredential && access.resumeCredentialExpiresAt && resumeScan) {
      try {
        await savePersistentInstallationResume({
          licenseId: access.licenseId,
          deviceId: resumeScan.deviceId,
          bootloaderSerial: resumeScan.bootloaderSerial,
          profileId: parsedProfile.data.id,
          releaseVersion: parsedManifest.data.version,
          resumeCredential: access.resumeCredential,
          resumeCredentialExpiresAt: access.resumeCredentialExpiresAt,
          scan: resumeScan
        });
        const persisted = await loadPersistentInstallationResume();
        if (persisted) setDurableResume(persisted);
      } catch {
        setInstallStatus("Durable browser recovery is unavailable; keep this tab open while the signed installation continues.");
      }
    }
    setStage("ready");
  }

  async function reviewInstallationReadiness() {
    if (simulatedFixture) {
      if (!artifactsReady || confirmation !== "ERASE PSG1" || !riskAccepted) return;
      setError("");
      setInstallStep("complete");
      setInstallStatus("Development simulation complete. No entitlement, artifact download, USB command, wipe, unlock, or flash occurred.");
      setStage("install");
      return;
    }
    const manifest = release?.manifest;
    const profileId = release?.profile?.id;
    if (!browserInstallationAllowed || !scan || !licenseId || !installerToken || !artifactsReady || confirmation !== "ERASE PSG1" || !riskAccepted
      || !manifest?.releaseId || !manifest.version || !manifest.artifacts || !manifest.flashPlan || !profileId) return;
    setError("");
    try {
      if (!resumeAuthorized) {
        // The API cannot observe a live USB transport. Re-read the same
        // selected PSG1 immediately before it records the irreversible
        // boundary, then repeat the check again when the first reboot is sent.
        await recheckStockLockedPsg1BeforeBoundary(scan, manifest.flashPlan);
        const boundary = await request<InstallationBoundaryResponse>("POST", `/v1/licenses/${licenseId}/installation-started`, installerToken, {
          termsVersion: "browser-installer-1",
          irreversibleRiskAcknowledged: true,
          confirmation: "ERASE PSG1",
          profileId,
          releaseId: manifest.releaseId,
          releaseVersion: manifest.version,
          manifestSha256: await canonicalSignedDocumentSha256(manifest),
          artifactHashes: artifactHashesFor(manifest.artifacts)
        });
        await savePersistentInstallationResume({
          licenseId, deviceId: scan.deviceId, bootloaderSerial: scan.bootloaderSerial, profileId,
          releaseVersion: manifest.version, resumeCredential: boundary.resumeCredential,
          resumeCredentialExpiresAt: boundary.resumeCredentialExpiresAt, scan
        });
        const persisted = await loadPersistentInstallationResume();
        if (!persisted) throw new Error("Persistent browser storage could not retain the exact Fastboot resume record. No USB command was sent; retry the review step.");
        setDurableResume(persisted);
      }
      setStage("install");
    } catch (cause) {
      setError(messageOf(cause)); setStage("risk");
    }
  }

  async function continueInstallation() {
    const currentRelease = release;
    const manifest = currentRelease?.manifest;
    const profileId = currentRelease?.profile?.id;
    if (!browserInstallationAllowed || !scan || !manifest?.artifacts || !manifest.version || !manifest.flashPlan || !profileId) return;
    setError("");
    let installer: BrowserInstaller | null = null;
    try {
      installer = new BrowserInstaller({
        scan, profileId, releaseVersion: manifest.version, flashPlan: manifest.flashPlan,
        artifacts: requiredInstallArtifacts(manifest.artifacts) as BrowserInstallArtifact[],
        ...(resumeCheckpoint ? { resumeCheckpoint } : {}),
        journalSink: (journal) => saveRemoteInstallationJournal(licenseId, installerToken, journal)
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
      setInstallStep(next);
      setResumeCheckpoint(installer.latestCheckpoint ?? null);
      if (next === "complete") {
        clearStoredResumeContext();
        setStoredResume(null);
        void clearPersistentInstallationResume();
        setDurableResume(null);
      }
      setInstallStatus(next === "complete" ? "Two cold boots and diagnostics passed." : "Step recorded. Follow the connection instruction below.");
    } catch (cause) {
      if (installer?.latestCheckpoint) {
        setResumeCheckpoint(installer.latestCheckpoint);
        // A sent/unknown reboot can already be in its target USB mode. Keep
        // the visible reconnect instruction aligned with the server-backed
        // checkpoint instead of retrying the previous screen blindly.
        if (isInstallUiStep(installer.latestCheckpoint.stage)) setInstallStep(installer.latestCheckpoint.stage);
      }
      setError(messageOf(cause, { fastbootPicker: isFastbootInstallStep(installStep) })); setInstallStatus("Installation paused safely. Reconnect the same PSG1 and retry this step.");
    }
  }

  async function prepareArtifacts() {
    if (simulatedFixture) {
      setError("");
      setStage("preparing");
      setArtifactsReady(true);
      setArtifactStatus("Simulated signed-artifact verification completed. No files were downloaded.");
      setStage("risk");
      return;
    }
    if (!browserInstallationAllowed || !release?.manifest?.artifacts || !release.manifest.flashPlan || !release.downloadUrls) return;
    setError(""); setArtifactStatus(""); setStage("preparing");
    try {
      const artifacts = requiredInstallArtifacts(release.manifest.artifacts);
      await assertArtifactCapacity(artifacts);
      for (const artifact of artifacts) {
        const url = release.downloadUrls[artifact.objectKey];
        if (!url) throw new Error(`The signed URL for ${artifact.id} is unavailable.`);
        await downloadVerifiedArtifact(artifact, url, (progress) => {
          setArtifactStatus(`${progress.phase === "download" ? "Downloading" : "Verifying"} ${progress.artifactId}: ${Math.floor(progress.downloaded / 1024 / 1024)} / ${Math.ceil(progress.total / 1024 / 1024)} MiB`);
        });
      }
      setArtifactsReady(true); setArtifactStatus("All signed release artifacts are verified in persistent browser storage."); setStage("risk");
    } catch (cause) { setError(messageOf(cause)); setStage("ready"); }
  }

  return <section className="wizard-card">
    <div className="wizard-heading"><span className="section-label">{privateBeta ? "PRIVATE BROWSER BETA" : "PSG1 BROWSER INSTALLER"}</span><h1>{outcome === "public" ? "Your PSG1 is ready." : "Check your PSG1."}</h1><p>{privateBeta ? "This private path remains code-gated and supervised. The scan itself is read-only." : "The scan is read-only. Revive will only offer installation after the API verifies this exact PSG1 and its safety preflight."}</p></div>
    {scan && <div className="scan-summary"><span>PSG1 detected</span><span>{scan.model || scan.product}</span><span>Battery {scan.batteryPercent}%</span><span>CPU ↔ Fastboot identity ✓</span></div>}
    {stage === "intro" && <div className="wizard-step"><Step number={1} title="Read-only hardware scan" /><p>Connect the powered-on PSG1 with USB debugging authorized. Chrome or Edge will ask you to select it again after rebooting to Fastboot.</p><button className="button primary wide" disabled={!browserReady || !API} onClick={scanDevice}>Connect and scan PSG1</button>{storedResume && <button className="button ghost wide" disabled={!API} onClick={resumeStoredInstallation}>Resume saved installation</button>}{durableResume && <button className="button ghost wide" disabled={!browserReady || !API} onClick={resumeFastbootOnlyInstallation}>Resume saved Fastboot installation</button>}<small>Use Chrome or Edge on macOS or Windows with a data-capable cable.{durableResume ? " A saved Fastboot resume is available only for this browser's exact signed installation and is rechecked before continuing." : storedResume ? " A saved resume is available only in this browser session and is rechecked before continuing." : ""}</small>{developmentHardwareFixture && <button className="button ghost wide" disabled={!API} onClick={simulateStockDevice}>Simulate stock PSG1</button>}</div>}
    {stage === "adb" && <Progress title="Reading the PSG1 identity and safety preflight…" />}
    {stage === "bootloader" && <Progress title="Restarting the PSG1 into Fastboot…" />}
    {stage === "fastbootWaiting" && <Progress title="Waiting for the PSG1 Fastboot USB interface…" />}
    {stage === "fastbootReady" && <div className="wizard-step"><Step number={2} title="Select Fastboot PSG1" /><p>The handheld restarted. Select its Fastboot interface in the next browser prompt.</p><button className="button primary wide" onClick={continueFastbootScan}>Select Fastboot PSG1</button></div>}
    {stage === "fastboot" && <Progress title="Cross-checking the immutable PSG1 identity…" />}
    {stage === "session" && <Progress title="Checking the signed compatibility profile…" />}
    {stage === "scanOutcome" && decision && outcome && <ScanOutcomePanel
      outcome={outcome}
      blockers={decision.blockers}
      {...(compatibilityReportAllowed ? { reportAction: {
        consented: reportConsented,
        submitting: reportStatus === "submitting",
        submitted: reportStatus === "submitted",
        onConsentChange: setReportConsented,
        onSubmit: submitCompatibilityReport
      } } : {})}
      {...(publicResumeAllowed ? { resumeAction: { onResume: resumePublicInstallation } } : {})}
    />}
    {stage === "publicActivate" && <div className="success"><Step number={3} title="Free public activation" /><p>This compatible, stock-locked PSG1 is cleared for the public release. Activation is free and binds the signed installer authorization to this device.</p><button className="button primary wide" disabled={!canUsePublicInstaller(session, scan)} onClick={activatePublicAccess}>Activate free public access</button>{publicResumeAllowed && <button className="button ghost wide" onClick={resumePublicInstallation}>Resume an interrupted installation</button>}<small>No code, payment, or Discord ticket is required. Resume only continues an installation that already crossed the signed boundary on this exact PSG1.</small></div>}
    {stage === "betaCode" && privateBeta && (simulatedFixture
      ? <div className="wizard-step"><Step number={3} title="Simulate hardware-pilot authorization" /><p>This development-only path previews the pilot screens without consuming your one-use invite or authorizing a real device.</p><button className="button primary wide" onClick={authorizeSimulatedPilot}>Continue simulated pilot</button><small>No entitlement, artifact download, USB command, wipe, unlock, or flash can occur in this simulation.</small></div>
      : <div className="wizard-step"><Step number={3} title="Redeem beta tester code" /><p>The original private beta has ended. This path remains only for community development; no new codes are issued.</p><a className="button ghost wide" href={COMMUNITY_URL} target="_blank" rel="noreferrer">View community issues ↗</a><label className="field">One-time beta code<input value={betaCode} onChange={(event) => setBetaCode(event.target.value)} placeholder="rpb_…" autoComplete="off" spellCheck={false} /></label><button className="button primary wide" disabled={!betaCode.trim() || !canUsePrivateBeta(session, scan)} onClick={redeemBetaCode}>Activate free beta access</button><button className="button ghost wide" disabled={!canUsePrivateBeta(session, scan)} onClick={resumeBetaInstallation}>Resume this PSG1&apos;s beta</button><small>Do not share your code. It cannot be moved to another PSG1 after redemption.</small></div>)}
    {stage === "activating" && <Progress title={privateBeta ? "Binding this code to your PSG1 and authorizing the signed beta release…" : "Authorizing the signed release for this PSG1…"} />}
    {stage === "ready" && <div className="success"><strong>✓ {simulatedFixture ? "Simulated pilot" : privateBeta ? "Beta release" : "Release"} authorized</strong><p>{simulatedFixture ? "This is a UI-only authorization preview. No real release, entitlement, or artifact is being used." : <>Release {release?.manifest?.version ?? "authorized"} is signed for this PSG1. Aurora Store and RetroArch are included as verified post-flash APKs.</>}</p><button className="button primary wide" disabled={!simulatedFixture && !browserInstallationAllowed} onClick={prepareArtifacts}>{simulatedFixture ? "Simulate artifact verification" : "Download and verify release artifacts"}</button></div>}
    {stage === "preparing" && <Progress title={artifactStatus || "Preparing signed release artifacts in persistent browser storage…"} />}
    {stage === "risk" && <div className="wizard-step"><Step number={4} title="Irreversible installation" /><div className="warning"><strong>No echOS recovery image is provided.</strong><p>This process erases all data, leaves the bootloader unlocked, may make restoration impossible, and can leave the device unusable. {simulatedFixture ? "This development preview will stop before every device command." : privateBeta ? "This historical beta path is unsupported." : "Continue only if you accept those risks."}</p></div><p className="success">✓ {artifactStatus || "Signed release artifacts verified"}</p><label className="checkbox"><input type="checkbox" checked={riskAccepted} onChange={(event) => setRiskAccepted(event.target.checked)} /> I understand and accept the irreversible installation risks.</label><label className="field">Type <b>ERASE PSG1</b> to start<input value={confirmation} onChange={(event) => setConfirmation(event.target.value)} autoComplete="off" /></label><button className="button danger wide" disabled={(!simulatedFixture && !browserInstallationAllowed) || !artifactsReady || !riskAccepted || confirmation !== "ERASE PSG1"} onClick={reviewInstallationReadiness}>{simulatedFixture ? "Complete safe simulation" : "Review installation readiness"}</button></div>}
    {stage === "install" && <div className="pending"><strong>{simulatedFixture ? "✓ Hardware-pilot simulation complete" : installStep === "complete" ? `✓ ${privateBeta ? "Beta " : ""}installation complete` : "Destructive boundary recorded."}</strong><p>{simulatedFixture ? "The complete authorization, artifact, and risk-confirmation UI was exercised without touching a device." : browserInstallationAllowed ? installInstruction(installStep, privateBeta) : "This browser session is not authorized to send Fastboot commands. No device change was made."}</p>{!simulatedFixture && browserInstallationAllowed && installStep !== "complete" && <button className="button danger wide" onClick={continueInstallation}>{installButton(installStep)}</button>}<small>{installStatus || "Do not unlock, flash, or use generic Fastboot commands outside this signed installer."}</small></div>}
    {error && <p className="error" role="alert">{error}</p>}
    {needsWindowsFastbootSetup && <div className="notice"><strong>Windows Fastboot setup</strong><p>Install the WinUSB driver for <b>USB Download Gadget</b> only, then retry this step. Do not replace the <b>Android ADB Interface</b> driver.</p>{signedWindowsDriver ? <><a className="text-link" href={signedWindowsDriver.packageUrl} target="_blank" rel="noreferrer">Download signed PSG1 Fastboot driver ↗</a><small>Signed release record: installer SHA-256 {signedWindowsDriver.installerSha256}; catalog SHA-256 {signedWindowsDriver.catalogSha256}; signer {signedWindowsDriver.authenticodeSigner}.</small></> : <Link className="text-link" href="/docs#windows-fastboot">Open the safe Windows setup steps →</Link>}</div>}
  </section>;
}

function Step({ number, title }: { number: number; title: string }) { return <h2><span>{number}.</span>{" "}{title}</h2>; }
function Progress({ title }: { title: string }) { return <div className="pending"><strong>{title}</strong><div className="scanner"><i /><span>Keep the cable connected.</span></div></div>; }

function ScanOutcomePanel({ outcome, blockers, reportAction, resumeAction }: { outcome: ScanOutcome; blockers: string[]; reportAction?: CompatibilityReportAction; resumeAction?: InstallationResumeAction }) {
  const details = blockers.length > 0 && <ul>{blockers.map((blocker) => <li key={blocker}>{remediationForBlocker(blocker)}</li>)}</ul>;
  if (outcome === "already_modified") return <div className="blocked"><strong>Previously modified devices are not part of this release.</strong><p>Revive will not unlock, wipe, or flash an already-modified PSG1 through the public browser installer.</p>{details}{resumeAction && <InstallationResume action={resumeAction} />}</div>;
  if (outcome === "stock_unlocked") return <div className="blocked"><strong>Previously modified devices are not part of this release.</strong><p>This PSG1 already has an unlocked bootloader. For safety, the browser installer starts only from a supported stock-locked device. No Fastboot command was sent.</p>{details}{resumeAction && <InstallationResume action={resumeAction} />}</div>;
  if (outcome === "development_fixture") return <div className="blocked"><strong>This is a development fixture result.</strong><p>It can exercise the scan path, but it is never eligible to unlock, wipe, or flash a device.</p>{details}</div>;
  if (outcome === "unsupported") return <div className="blocked"><strong>Hardware/build not recognized yet.</strong><p>This is not a permanent rejection: no modification was made, and you can optionally send a redacted report so we can review this stock hardware/build combination.</p>{details}{reportAction && <CompatibilityReportConsent action={reportAction} />}</div>;
  if (outcome === "preflight") return <div className="blocked"><strong>This PSG1 needs attention before installation.</strong><p>The signed hardware profile matched, but the required safety preflight did not pass. No device change was made.</p>{details}</div>;
  if (outcome === "scan_only") return <div className="pending"><strong>Compatible; installer not open.</strong><p>This PSG1 matched its signed profile, but installation is not available in this mode. The scan did not unlock, wipe, flash, or bind the device.</p>{details}{resumeAction && <InstallationResume action={resumeAction} />}</div>;
  if (outcome === "public_paused") return <div className="pending"><strong>Compatible; installer temporarily unavailable.</strong><p>This PSG1 passed the signed compatibility scan, but the public installer is temporarily paused or its signed release is not ready. The scan did not unlock, wipe, flash, or bind the device.</p>{details}{resumeAction && <InstallationResume action={resumeAction} />}</div>;
  return <div className="pending"><strong>Installation is not available for this PSG1 yet.</strong><p>The scan completed without changing the device. Check the listed requirements before trying again.</p>{details}{resumeAction && <InstallationResume action={resumeAction} />}</div>;
}

function remediationForBlocker(blocker: string): string {
  const messages: Record<string, string> = {
    BATTERY_OR_CHARGING_REQUIRED: "Charge the PSG1 to at least 50%, or leave it connected to power while charging, then scan again.",
    HOST_STORAGE_INSUFFICIENT: "Free persistent storage in this browser for the signed release, then scan again. Browser private/incognito windows often cannot keep enough storage.",
    SYSTEM_PARTITION_OUT_OF_RANGE: "This PSG1 has a system partition layout the signed release cannot safely use. Do not flash it manually; send the optional report if offered.",
    STOCK_SYSTEM_OUT_OF_RANGE: "The mounted stock system size is outside the signed hardware profile. A replacement-image size is not used for this check. Do not flash it manually; send the optional report if offered.",
    SUPER_PARTITION_OUT_OF_RANGE: "This PSG1 has a super partition layout the signed release cannot safely use. Do not flash it manually; send the optional report if offered.",
    SERIAL_VERIFICATION_REQUIRED: "Reconnect with a data-capable cable and complete both Android and Fastboot selections so the CPU-to-Fastboot identity check can finish.",
    USB_STABILITY_REQUIRED: "Reconnect the cable directly to the computer, avoid hubs, then rerun the scan so the Android connection remains stable.",
    RECOVERY_CAPABILITY_REQUIRED: "The PSG1 did not expose the signed recovery/boot transition capability. Restart it normally and retry the read-only scan.",
    PROFILE_NOT_RECOGNIZED: "This stock hardware/build is not recognized by a signed profile yet. You may send the optional redacted compatibility report.",
    PROFILE_SELECTION_AMBIGUOUS: "More than one signed hardware profile matched with the same priority. Installation is paused until the profile set is corrected.",
    INSTALLER_SCAN_ONLY: "The compatible installer is currently closed. Your scan remains read-only.",
    PRIVATE_BETA_INVITE_REQUIRED: "This compatible device is in the supervised private-beta mode and needs its beta invitation.",
    PUBLIC_RELEASE_NOT_READY: "The public signed release materials are not ready yet. Your device was not changed.",
    INSTALLER_NEW_STARTS_PAUSED: "New installations are temporarily paused. If this exact PSG1 already started an installation, use the resume option instead.",
    DEVICE_STATE_STOCK_UNLOCKED: "The bootloader is already unlocked, so this device cannot start a new public installation.",
    DEVICE_STATE_ALREADY_MODIFIED: "This PSG1 already has a modified operating system and cannot start a new public installation.",
    DEVELOPMENT_FIXTURE_FORBIDDEN: "Development fixtures are never eligible for installation."
  };
  return messages[blocker] ?? "A signed installation requirement did not pass. No device change was made.";
}

function InstallationResume({ action }: { action: InstallationResumeAction }) {
  return <div className="wizard-step">
    <p><strong>Resume a prior installation</strong></p>
    <p>Use this only if this exact PSG1 already crossed the signed installer&apos;s destructive boundary. The server will verify the same device and exact signed release before offering any checkpoint; it cannot start a new installation.</p>
    <button className="button ghost wide" onClick={action.onResume}>Resume this signed installation</button>
  </div>;
}

function CompatibilityReportConsent({ action }: { action: CompatibilityReportAction }) {
  if (action.submitted) return <p className="success">✓ Your redacted compatibility report was submitted for review.</p>;
  return <div className="wizard-step">
    <p><strong>Optional compatibility report</strong></p>
    <p>Help us review this hardware/build combination. The report contains only redacted product, board, and build information—never a device ID, CPU or bootloader serial, USB identifier, token, or raw USB data.</p>
    <label className="checkbox"><input type="checkbox" checked={action.consented} onChange={(event) => action.onConsentChange(event.target.checked)} /> I consent to send this redacted compatibility report for review.</label>
    <button className="button ghost wide" disabled={!action.consented || action.submitting} onClick={action.onSubmit}>{action.submitting ? "Sending redacted report…" : "Send redacted compatibility report"}</button>
  </div>;
}

function resolveDecision(session: Session, scan: WebCompatibilityScan | null): ResolvedDecision {
  const decision = session.decision;
  const profileStatus = decisionStatus(decision?.profile ?? decision?.compatibility);
  const preflightStatus = decisionStatus(decision?.preflight);
  const reportedState = deviceStateOf(decision?.deviceState) ?? session.installationState;
  // A local observation of an unlocked or modified device always wins over a
  // remote value. This makes the browser fail closed if the two ever disagree.
  const deviceState = scan?.installationState && scan.installationState !== "stock_locked"
    ? scan.installationState
    : reportedState ?? "unknown";
  const profile = profileStatus === "matched" ? "matched"
    : profileStatus === "not_recognized" || profileStatus === "unsupported" ? "not_recognized"
      : profileStatus === "ambiguous" ? "ambiguous"
        : !decision && session.supported === true ? "matched"
          : !decision && session.supported === false ? "not_recognized"
            : "unknown";
  const preflight = preflightStatus === "passed" ? "passed"
    : preflightStatus === "blocked" || preflightStatus === "failed" ? "blocked"
      : preflightStatus === "not_run" ? "not_run"
        : !decision && session.supported === true ? "passed"
          : "unknown";
  const installerMode = installerModeOf(decision?.installerMode ?? decision?.availability?.status ?? session.installerMode);
  const canInstall = decision?.canInstall === true || decision?.availability?.canInstall === true;
  return {
    profile,
    preflight,
    deviceState,
    blockers: collectBlockers(decision),
    installerMode,
    // A missing structured decision must never become an install permit.
    canInstall: Boolean(decision && canInstall)
  };
}

export function scanOutcome(decision: ResolvedDecision, scan: WebCompatibilityScan | null): ScanOutcome {
  const state = scan?.installationState !== "stock_locked" ? scan?.installationState : decision.deviceState;
  if (state === "already_modified") return "already_modified";
  if (state === "stock_unlocked") return "stock_unlocked";
  if (state === "development_fixture") return "development_fixture";
  if (state !== "stock_locked") return "unavailable";
  if (decision.profile !== "matched") return "unsupported";
  if (decision.preflight !== "passed") return "preflight";
  if (decision.installerMode === "private_beta") return "private_beta";
  if (decision.installerMode === "public" && decision.canInstall) return "public";
  if (decision.installerMode === "scan_only") return "scan_only";
  if (decision.installerMode === "public") return "public_paused";
  return "unavailable";
}

function stageForSession(session: Session, scan: WebCompatibilityScan): Stage {
  const outcome = scanOutcome(resolveDecision(session, scan), scan);
  return outcome === "public" ? "publicActivate" : outcome === "private_beta" ? "betaCode" : "scanOutcome";
}

function canUsePublicInstaller(session: Session | null, scan: WebCompatibilityScan | null): boolean {
  if (!session || !isSafeStockScan(session, scan)) return false;
  const decision = resolveDecision(session, scan);
  return decision.installerMode === "public" && decision.canInstall;
}

function canUsePrivateBeta(session: Session | null, scan: WebCompatibilityScan | null): boolean {
  if (!session || !isSafeStockScan(session, scan)) return false;
  return resolveDecision(session, scan).installerMode === "private_beta";
}

function canBeginBrowserInstallation(session: Session | null, scan: WebCompatibilityScan | null, installerToken: string): boolean {
  if (!installerToken) return false;
  return canUsePublicInstaller(session, scan) || canUsePrivateBeta(session, scan);
}

export function canAttemptPublicResume(session: Session, scan: WebCompatibilityScan): boolean {
  // This is intentionally a UI affordance, not an authorization decision. A
  // crash can occur immediately after the irreversible boundary while the
  // device still looks stock-locked, so every real cross-mode scan may ask the
  // API whether this exact PSG1 has a resumable signed installation.
  return Boolean(session.browserToken && scan.serialVerified && scan.immutableSerialVerified && scan.bootloaderSerial);
}

function isSafeAuthorizedResume(session: Session | null, scan: WebCompatibilityScan | null): boolean {
  return Boolean(scan && scan.serialVerified && scan.immutableSerialVerified && scan.bootloaderSerial);
}

export function canOfferCompatibilityReport(session: Session, scan: WebCompatibilityScan, decision: ResolvedDecision, outcome: ScanOutcome): boolean {
  return session.supported === false
    && outcome === "unsupported"
    && decision.profile === "not_recognized"
    && decision.deviceState === "stock_locked"
    && scan.installationState === "stock_locked"
    && (scan.batteryPercent >= 50 || scan.charging)
    // Do not offer a report for an ambiguous profile selection or a generic
    // safety/preflight failure. This is specifically an unknown build/device.
    && decision.blockers.includes("PROFILE_NOT_RECOGNIZED");
}

/**
 * Produces the only browser-side compatibility payload accepted by the
 * optional report action. Do not add deviceId, bootloaderSerial, USB fields,
 * or raw transport data here: those values identify a physical device.
 */
export function buildRedactedCompatibilityReport(scan: WebCompatibilityScan): Record<string, string | number | boolean | null> {
  return {
    reportVersion: 1,
    product: redactCompatibilityReportText(scan.product),
    model: redactCompatibilityReportText(scan.model),
    board: redactCompatibilityReportText(scan.board),
    hardware: redactCompatibilityReportText(scan.hardware),
    buildFingerprint: redactCompatibilityReportText(scan.buildFingerprint),
    buildIncremental: redactCompatibilityReportText(scan.buildIncremental),
    systemBuildFingerprint: redactCompatibilityReportText(scan.systemBuildFingerprint),
    vendorBuildFingerprint: redactCompatibilityReportText(scan.vendorBuildFingerprint),
    systemBuildIncremental: redactCompatibilityReportText(scan.systemBuildIncremental),
    systemBuildType: redactCompatibilityReportText(scan.systemBuildType),
    androidApiLevel: scan.androidApiLevel,
    vendorApiLevel: scan.vendorApiLevel
  };
}

function redactCompatibilityReportText(value: string): string {
  return value
    .replace(/\b(?:i?serial(?:[_ -]?(?:no|number))?|device(?:[_ -]?(?:id|serial(?:[_ -]?(?:no|number))?))?|android[_ -]?id|bootloader[_ -]?serial|usb(?:[_ -]?serial)?)\b\s*[:=]\s*[^\s,;|/]+/giu, "[redacted]")
    .replace(/\b(?:usb\\?vid|vid|pid|idvendor|idproduct|vendor[_ -]?id|product[_ -]?id)[\s_:=-]*(?:0x)?[0-9a-f]{4}\b/giu, "[redacted-usb-id]")
    .replace(/\b(?:0x)?[0-9a-f]{4}:(?:0x)?[0-9a-f]{4}\b/giu, "[redacted-usb-id]")
    .replace(/\bPS\d{2}(?:-[A-Za-z0-9]+){3,}\b/giu, "[redacted-device-serial]")
    .replace(/\b[a-f0-9]{64}\b/giu, "[redacted-hash]")
    .slice(0, 1_000);
}

function isSafeStockScan(session: Session, scan: WebCompatibilityScan | null): boolean {
  const decision = resolveDecision(session, scan);
  return scan?.installationState === "stock_locked"
    && decision.deviceState === "stock_locked"
    && decision.profile === "matched"
    && decision.preflight === "passed";
}

function decisionStatus(value: string | DecisionPart | undefined): string | undefined {
  return typeof value === "string" ? value : value?.status;
}

function deviceStateOf(value: InstallationState | DecisionPart | undefined): InstallationState | undefined {
  const state = typeof value === "string" ? value : value?.installationState;
  return isInstallationState(state) ? state : undefined;
}

function isInstallationState(value: string | undefined): value is InstallationState {
  return value === "stock_locked" || value === "stock_unlocked" || value === "already_modified" || value === "development_fixture";
}

function installerModeOf(value: string | undefined): InstallerMode | "unknown" {
  return value === "scan_only" || value === "private_beta" || value === "public" ? value : "unknown";
}

function collectBlockers(decision: SessionDecision | undefined): string[] {
  if (!decision) return [];
  const parts = [
    decision.blockers,
    objectBlockers(decision.profile),
    objectBlockers(decision.compatibility),
    objectBlockers(decision.preflight),
    objectBlockers(decision.deviceState),
    decision.availability?.blockers
  ];
  return [...new Set(parts.flatMap((blockers) => blockers ?? []).filter((blocker) => typeof blocker === "string" && blocker.trim().length > 0))];
}

function objectBlockers(value: string | InstallationState | DecisionPart | undefined): string[] | undefined {
  return typeof value === "object" && value ? value.blockers : undefined;
}

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

async function verifiedWindowsFastbootDriver(envelope: PublicDriverEnvelope): Promise<SignedWindowsFastbootDriver> {
  if (!envelope.manifest || typeof envelope.manifest !== "object" || Array.isArray(envelope.manifest) || !envelope.signature) {
    throw new Error("The public Windows driver record is incomplete.");
  }
  await verifySignedReleaseDocument(envelope.manifest, envelope.signature);
  const manifest = releaseManifestSchema.safeParse({ ...envelope.manifest, signature: envelope.signature });
  const driver = manifest.success ? manifest.data.publicEvidence?.windowsFastbootDriver : undefined;
  if (!driver) throw new Error("The signed public release does not contain a Windows Fastboot driver record.");
  return driver;
}

const ERROR_MESSAGES: Record<string, string> = {
  BETA_INSTALLER_CLOSED: "The browser beta installer is not open yet.", BETA_CODE_REQUIRED: "A Discord beta code is required.",
  BETA_INVITE_INVALID_OR_USED: "That beta code is invalid, expired, or already bound to another PSG1.", BETA_COHORT_FULL: "The current beta cohort is full.",
  BETA_ENTITLEMENT_NOT_FOUND: "This PSG1 does not have an active beta entitlement yet.",
  DESTRUCTIVE_TEST_MODE_BLOCKED: "Destructive installation is blocked for modified or simulated devices.",
  UNSUPPORTED_FIRMWARE: "This firmware is not supported. No modification was performed.",
  PUBLIC_RESUME_NOT_FOUND: "No previously started public installation was found for this PSG1.",
  FASTBOOT_RESUME_NOT_FOUND: "The saved Fastboot resume record is expired or no longer matches this PSG1. Re-run the read-only scan while the device is in Android, if possible.",
  RESUME_RELEASE_UNAVAILABLE: "The exact signed release for this interrupted installation is not available. No Fastboot command was sent.",
  INSTALLATION_BINDING_MISMATCH: "This browser session does not match the exact signed release already bound to this PSG1.",
  INSTALLATION_RELEASE_MISMATCH: "The signed release changed or does not match this PSG1. No Fastboot command was sent.",
  INSTALLER_NEW_STARTS_PAUSED: "New installations are temporarily paused. An already-started PSG1 can still resume its exact signed release.",
  PUBLIC_RELEASE_NOT_READY: "The public release materials are not ready yet. No device change was made.",
  SESSION_PROFILE_CHANGED: "The signed compatibility profile changed after this scan. Run the read-only scan again before starting installation.",
  INSTALLER_UPDATE_REQUIRED: "This browser installer is older than the signed release requires. Refresh the page and try again."
};
function messageOf(cause: unknown, options: { fastbootPicker?: boolean } = {}): string {
  if (cause instanceof DOMException && cause.name === "NotFoundError") {
    if (options.fastbootPicker && isWindowsHost()) {
      return "No PSG1 Fastboot device appeared in the browser picker. Windows Fastboot driver setup is required before retrying.";
    }
    return "No PSG1 Fastboot device was selected. Keep the cable connected, wait a few seconds for Fastboot to appear, then try again.";
  }
  const message = cause instanceof Error ? cause.message : "Request failed";
  if (/failed to execute ['"]open['"] on ['"]usbdevice['"]: access denied|access denied/iu.test(message)) {
    const setup = isWindowsHost()
      ? "Windows Fastboot driver setup is required before retrying."
      : "Fastboot USB driver or permission setup is required before retrying.";
    return `The computer detected the PSG1 Fastboot interface but could not open it. No device change was made. ${setup}`;
  }
  return message;
}
function isWindowsHost(): boolean { return typeof navigator !== "undefined" && /Windows/iu.test(navigator.userAgent); }
export function installerVersionSatisfies(current: string, minimum: string): boolean {
  const parse = (value: string): [number, number, number] | null => {
    const match = /^(\d+)\.(\d+)\.(\d+)(?:[-+][0-9A-Za-z.-]+)?$/u.exec(value);
    if (!match) return null;
    const parts = match.slice(1, 4).map((part) => Number.parseInt(part, 10));
    return parts.every(Number.isSafeInteger) ? parts as [number, number, number] : null;
  };
  const actual = parse(current);
  const required = parse(minimum);
  if (!actual || !required) return false;
  return actual[0] > required[0]
    || (actual[0] === required[0] && actual[1] > required[1])
    || (actual[0] === required[0] && actual[1] === required[1] && actual[2] >= required[2]);
}
function isFastbootInstallStep(step: InstallUiStep): boolean {
  return step === "awaiting_bootloader_unlock" || step === "awaiting_vbmeta_bootloader" || step === "awaiting_fastbootd_system";
}
function isInstallUiStep(value: string): value is InstallUiStep {
  return [
    "start", "awaiting_bootloader_unlock", "awaiting_unlocked_android", "awaiting_vbmeta_bootloader", "awaiting_system_android",
    "awaiting_fastbootd_system", "awaiting_postflash_android", "awaiting_first_cold_boot", "awaiting_second_cold_boot", "complete"
  ].includes(value as InstallUiStep);
}
function requiredInstallArtifacts(artifacts: ReleaseArtifact[]): ReleaseArtifact[] {
  const required = [
    ["android_system", "system"], ["verified_boot", "vbmeta"], ["diagnostics", "apk"],
    ["diagnostics_test", "apk"], ["aurora_store", "apk"], ["retroarch", "apk"]
  ] as const;
  const selected = required.map(([component, kind]) => artifacts.find((artifact) => artifact.component === component && artifact.kind === kind && artifact.delivery === "private"));
  if (selected.some((artifact) => !artifact)) throw new Error("The signed release is missing a required system, vbmeta, diagnostics pair, Aurora Store, or RetroArch artifact.");
  return selected as ReleaseArtifact[];
}
function artifactHashesFor(artifacts: ReleaseArtifact[]): Record<string, string> {
  return Object.fromEntries(requiredInstallArtifacts(artifacts).map((artifact) => [artifact.id, artifact.sha256]));
}

async function loadRemoteInstallationJournal(licenseId: string, installerToken: string): Promise<RemoteInstallationJournal | null> {
  try {
    const response = await request<{ entry?: RemoteInstallationJournal | null }>("GET", `/v1/licenses/${licenseId}/installation-journal`, installerToken);
    return response.entry ?? null;
  } catch (cause) {
    // A newly activated device has not crossed the destructive boundary yet,
    // so the server correctly has no journal. Other failures must stop the
    // flow rather than silently dropping durable-resume state.
    if (cause instanceof Error && /INSTALLATION_NOT_STARTED/iu.test(cause.message)) return null;
    throw cause;
  }
}

async function saveRemoteInstallationJournal(licenseId: string, installerToken: string, journal: InstallationJournal): Promise<void> {
  await request("POST", `/v1/licenses/${licenseId}/installation-journal`, installerToken, {
    profileId: journal.profileId,
    releaseVersion: journal.releaseVersion,
    artifactHashes: journal.artifactHashes,
    stage: journal.stage,
    operation: journal.operation,
    operationState: journal.operationState,
    operationIndex: journal.operationIndex,
    operationCount: journal.operationCount
  });
}

export async function matchingJournalStep(
  release: Release,
  scan: WebCompatibilityScan | null,
  remoteJournal: RemoteInstallationJournal | null = null,
  allowEmptyCheckpoint = false
): Promise<JournalResume | null> {
  if (!scan || !release.manifest?.version || !release.profile?.id || !release.manifest.artifacts) return null;
  const profileId = release.profile.id;
  const releaseVersion = release.manifest.version;
  if (!remoteJournal) {
    return allowEmptyCheckpoint
      ? { step: "start", operation: "begin", operationState: "unknown", operationIndex: 0, operationCount: 1 }
      : null;
  }
  const validSteps = new Set<InstallUiStep>([
    "start", "awaiting_bootloader_unlock", "awaiting_unlocked_android", "awaiting_vbmeta_bootloader", "awaiting_system_android",
    "awaiting_fastbootd_system", "awaiting_postflash_android", "awaiting_first_cold_boot", "awaiting_second_cold_boot", "complete"
  ]);
  const expected = artifactHashesFor(release.manifest.artifacts);
  const journal = remoteJournal;
  if (!validSteps.has(journal.stage as InstallUiStep)
    || journal.deviceId !== scan.deviceId
    || journal.profileId !== profileId
    || journal.releaseVersion !== releaseVersion
    || !artifactHashMapsMatch(journal.artifactHashes, expected)
    || !Number.isInteger(journal.operationIndex)
    || !Number.isInteger(journal.operationCount)
    || journal.operationIndex < 0
    || journal.operationCount < 1
    || journal.operationIndex >= journal.operationCount) return null;
  // The server record is authoritative. Local storage may be stale or edited;
  // it is never allowed to advance a checkpoint beyond the server journal.
  return {
    step: journal.stage as InstallUiStep,
    operation: journal.operation,
    operationState: journal.operationState,
    operationIndex: journal.operationIndex,
    operationCount: journal.operationCount
  };
}

function artifactHashMapsMatch(left: Record<string, string>, right: Record<string, string>): boolean {
  const leftEntries = Object.entries(left);
  return leftEntries.length === Object.keys(right).length && leftEntries.every(([id, hash]) => right[id] === hash);
}
function installInstruction(step: InstallUiStep, privateBeta: boolean): string {
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
    complete: `Aurora Store, RetroArch, diagnostics, and two cold boots were verified.${privateBeta ? " Keep your Discord ticket open for handoff." : ""}`
  };
  return instructions[step];
}
function installButton(step: InstallUiStep): string {
  return step === "start" ? "Start signed installation" : step === "complete" ? "Complete" : "Select same PSG1 and continue";
}
function waitForFastbootEnumeration(): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, 7_000));
}

function base64Url(bytes: Uint8Array) { return btoa(String.fromCharCode(...bytes)).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", ""); }
function browserCapabilitySnapshot() { return typeof navigator !== "undefined" && WebAdbPsg1.supported() && WebFastbootPsg1.supported(); }

function loadStoredResumeContext(): StoredResumeContext | null {
  if (typeof window === "undefined") return null;
  try {
    const value: unknown = JSON.parse(window.sessionStorage.getItem(STORED_RESUME_CONTEXT_KEY) ?? "null");
    if (!value || typeof value !== "object") return null;
    const context = value as Partial<StoredResumeContext>;
    const session = context.session as Partial<Session> | undefined;
    const scan = context.scan as Partial<WebCompatibilityScan> | undefined;
    if (!session || typeof session.sessionId !== "string" || !session.sessionId
      || typeof session.browserToken !== "string" || !session.browserToken
      || typeof session.expiresAt !== "string" || Date.parse(session.expiresAt) <= Date.now()
      || !scan || typeof scan.deviceId !== "string" || !/^[a-f0-9]{64}$/u.test(scan.deviceId)
      || typeof scan.bootloaderSerial !== "string" || !scan.bootloaderSerial
      || scan.serialVerified !== true || scan.immutableSerialVerified !== true) return null;
    return context as StoredResumeContext;
  } catch {
    return null;
  }
}

function saveStoredResumeContext(context: StoredResumeContext): void {
  if (typeof window === "undefined") return;
  try { window.sessionStorage.setItem(STORED_RESUME_CONTEXT_KEY, JSON.stringify(context)); } catch { /* Browser storage is optional. */ }
}

function clearStoredResumeContext(): void {
  if (typeof window === "undefined") return;
  try { window.sessionStorage.removeItem(STORED_RESUME_CONTEXT_KEY); } catch { /* Browser storage is optional. */ }
}
