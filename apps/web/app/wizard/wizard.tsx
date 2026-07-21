"use client";

import { useEffect, useState, useSyncExternalStore } from "react";
import type { WalletAccount } from "@wallet-standard/base";
import { address, createSolanaRpc, mainnet } from "@solana/kit";
import {
  DEVELOPMENT_FIXTURE_COMPATIBILITY,
  DEVELOPMENT_FIXTURE_DEVICE_ID,
  LICENSE_PRICE_USDC,
  SOLANA_USDC_MINT,
  TREASURY_WALLET,
  USDC_AMOUNT_BASE_UNITS,
  webSessionProofMessage
} from "@revive-psg1/contracts";
import bs58 from "bs58";
import nacl from "tweetnacl";
import { apiUrl, publicSalesState, solanaRpcUrl } from "../../lib/public-config";
import { buildPaymentTransaction } from "../../lib/payment-transaction";
import {
  connectWallet,
  isUsableMainnetAccount,
  signAndSendMainnetTransaction,
  signExactMessage,
  watchCompatibleWallets,
  watchWalletAccounts,
  type ReviveWallet
} from "../../lib/solana-wallet";
import { finalizeWebScan, WebAdbPsg1, WebFastbootPsg1, type WebCompatibilityScan } from "../../lib/webusb-psg1";

const API = apiUrl();
const WEB_VERSION = "0.2.0-web-alpha";
const LICENSE_PRICE_LABEL = Number(LICENSE_PRICE_USDC).toFixed(2);

type Stage = "intro" | "adb" | "bootloader" | "fastbootReady" | "fastboot" | "session" | "unsupported" | "compatible" | "freeAccess" | "activatingFree" | "wallet" | "authorize" | "order" | "paying" | "verifying" | "paymentPending" | "installerProof" | "ready";
type AdbCompatibilityScan = Awaited<ReturnType<WebAdbPsg1["readCompatibility"]>>;
type Session = { sessionId: string; supported: boolean; browserToken: string; profileId: string | null; expiresAt: string; installationState: WebCompatibilityScan["installationState"]; destructiveAllowed: false };
type Order = {
  orderId: string;
  kind: "paid" | "promo";
  reference: string;
  amountBaseUnits: string;
  treasury: string;
  mint: string;
  expiresAt: string;
};
type Pending = { orderId: string; kind: "paid" | "promo"; transactionSignature?: string };
type ReleaseAccess = { manifest?: { version?: string }; profile?: { id?: string } };

export function Wizard({ earlyAccessFree, developmentHardwareFixture, compatibilityCheckerOnly }: { earlyAccessFree: boolean; developmentHardwareFixture: boolean; compatibilityCheckerOnly: boolean }) {
  const [stage, setStage] = useState<Stage>("intro");
  const [scan, setScan] = useState<WebCompatibilityScan | null>(null);
  const [session, setSession] = useState<Session | null>(null);
  const [pendingFastboot, setPendingFastboot] = useState<{ snapshot: AdbCompatibilityScan } | null>(null);
  const [wallets, setWallets] = useState<ReviveWallet[]>([]);
  const [wallet, setWallet] = useState<ReviveWallet | null>(null);
  const [account, setAccount] = useState<WalletAccount | null>(null);
  const [walletToken, setWalletToken] = useState("");
  const [authorizedWallet, setAuthorizedWallet] = useState("");
  const [promo, setPromo] = useState("");
  const [pending, setPending] = useState<Pending | null>(null);
  const [orderId, setOrderId] = useState("");
  const [licenseId, setLicenseId] = useState("");
  const [release, setRelease] = useState<ReleaseAccess | null>(null);
  const [error, setError] = useState("");

  useEffect(() => earlyAccessFree ? undefined : watchCompatibleWallets(setWallets), [earlyAccessFree]);
  useEffect(() => {
    if (!wallet) return;
    return watchWalletAccounts(wallet, (accounts) => {
      setAccount((current) => accounts.find((candidate) => candidate.address === current?.address && isUsableMainnetAccount(candidate)) ?? accounts.find(isUsableMainnetAccount) ?? null);
    });
  }, [wallet]);

  const browserReady = useSyncExternalStore(subscribeBrowserCapability, browserCapabilitySnapshot, () => false);
  const canCreatePaidOrder = publicSalesState === "public";

  async function scanDevice() {
    if (!browserReady || !API) return;
    setError("");
    setStage("adb");
    let adb: WebAdbPsg1 | null = null;
    let rebootStarted = false;
    try {
      adb = await WebAdbPsg1.request();
      const snapshot = await adb.readCompatibility();
      if (!snapshot.usbStable) throw new Error("The PSG1 USB connection was not stable enough for a safe scan.");
      setPendingFastboot({ snapshot });
      setStage("bootloader");
      rebootStarted = true;
      await adb.rebootBootloader();
      adb = null;
      setStage("fastbootReady");
    } catch (cause) {
      setError(messageOf(cause));
      setStage(rebootStarted ? "fastbootReady" : "intro");
    } finally {
      if (!rebootStarted) await adb?.close().catch(() => undefined);
    }
  }

  async function continueFastbootScan() {
    if (!pendingFastboot || !API) return;
    setError("");
    setStage("fastboot");
    let fastboot: WebFastbootPsg1 | null = null;
    let fastbootRebooted = false;
    try {
      // WebUSB requires this second requestDevice call to originate from its
      // own user gesture after the PSG1 re-enumerates in Fastboot mode.
      fastboot = await WebFastbootPsg1.request();
      const completed = await finalizeWebScan(pendingFastboot.snapshot, fastboot);
      setScan(completed);
      setStage("session");
      const created = await createWebSession(completed);
      setSession(created);
      await fastboot.reboot();
      fastbootRebooted = true;
      await fastboot.close().catch(() => undefined);
      fastboot = null;
      setPendingFastboot(null);
      setStage(postScanStage(created.supported, compatibilityCheckerOnly, earlyAccessFree));
    } catch (cause) {
      setError(messageOf(cause));
      if (fastboot) {
        setPendingFastboot(null);
        setStage("intro");
      } else {
        setStage("fastbootReady");
      }
    } finally {
      if (fastboot && !fastbootRebooted) await fastboot.reboot().catch(() => undefined);
      await fastboot?.close().catch(() => undefined);
    }
  }

  async function simulateStockDevice() {
    if (!developmentHardwareFixture || !API) return;
    setError("");
    setStage("session");
    try {
      const completed: WebCompatibilityScan = {
        ...DEVELOPMENT_FIXTURE_COMPATIBILITY,
        deviceId: DEVELOPMENT_FIXTURE_DEVICE_ID
      };
      setScan(completed);
      const created = await createWebSession(completed, true);
      setSession(created);
      setStage(postScanStage(created.supported, compatibilityCheckerOnly, earlyAccessFree));
    } catch (cause) {
      setError(messageOf(cause));
      setStage("intro");
    }
  }

  async function retrySecureSession() {
    if (!scan) return;
    setError("");
    setStage("session");
    try {
      // A completed hardware scan reached Fastboot through the ADB reboot
      // service, which is stronger evidence than an on-device reboot binary.
      const verifiedScan = scan.installationState === "development_fixture" ? scan : { ...scan, recoveryCapable: true };
      setScan(verifiedScan);
      const created = await createWebSession(verifiedScan, verifiedScan.installationState === "development_fixture");
      setSession(created);
      setStage(postScanStage(created.supported, compatibilityCheckerOnly, earlyAccessFree));
    } catch (cause) {
      setError(messageOf(cause));
      setStage("intro");
    }
  }

  async function activateEarlyAccess() {
    if (!session) return;
    setError("");
    setStage("activatingFree");
    try {
      const access = await request<{ orderId: string; licenseId: string; webInstallerToken: string }>(
        "POST",
        "/v1/early-access/activate",
        session.browserToken,
        { sessionId: session.sessionId }
      );
      setOrderId(access.orderId);
      setLicenseId(access.licenseId);
      const authorizedRelease = await request<ReleaseAccess>("GET", "/v1/releases/stable", access.webInstallerToken);
      setRelease(authorizedRelease);
      setStage("ready");
    } catch (cause) {
      setError(messageOf(cause));
      setStage("freeAccess");
    }
  }

  async function chooseWallet(value: ReviveWallet) {
    setError("");
    try {
      const selected = await connectWallet(value);
      setWallet(value);
      setAccount(selected);
    } catch (cause) { setError(messageOf(cause)); }
  }

  async function authorizeCheckout() {
    if (!wallet || !account || !session) return;
    setError("");
    setStage("authorize");
    try {
      const challenge = await request<{ challengeId: string; message: string }>("POST", "/v1/wallet/challenge", session.browserToken, {
        sessionId: session.sessionId, wallet: account.address
      });
      const signature = await signExactMessage(wallet, account, new TextEncoder().encode(challenge.message));
      const verified = await request<{ walletToken: string }>("POST", "/v1/wallet/verify", session.browserToken, {
        challengeId: challenge.challengeId, signature: bs58.encode(signature)
      });
      setWalletToken(verified.walletToken);
      setAuthorizedWallet(account.address);
      setStage("order");
    } catch (cause) {
      setError(messageOf(cause));
      setStage("wallet");
    }
  }

  async function createOrder() {
    if (!wallet || !account || !session || !walletToken) return;
    if (account.address !== authorizedWallet) {
      setError("The wallet account changed. Authorize checkout again.");
      setStage("wallet");
      return;
    }
    setError("");
    setStage("paying");
    let created: Order | undefined;
    let transactionSignature: string | undefined;
    try {
      const result = await request<Order & { alreadyLicensed?: boolean; licenseId?: string; orderId?: string; walletAuthorizationRequired?: boolean }>(
        "POST", "/v1/orders", walletToken, { sessionId: session.sessionId, ...(promo.trim() ? { betaInviteToken: promo.trim() } : {}) }
      );
      if (result.alreadyLicensed) {
        if (result.walletAuthorizationRequired || !result.orderId || !result.licenseId) throw new Error("This PSG1 is licensed to a different receipt wallet. Connect the wallet that originally paid to continue in the web installer.");
        setOrderId(result.orderId);
        setLicenseId(result.licenseId);
        await authorizeInstaller(result.orderId);
        return;
      }
      assertSafeOrder(result);
      created = result;
      if (result.kind === "paid") transactionSignature = await sendPayment(result);
      const next = { orderId: result.orderId, kind: result.kind, ...(transactionSignature ? { transactionSignature } : {}) };
      setPending(next);
      setStage("verifying");
      const verified = await verifyOrder(next);
      setOrderId(result.orderId);
      setLicenseId(verified.licenseId);
      setPending(null);
      await authorizeInstaller(result.orderId);
    } catch (cause) {
      setError(messageOf(cause));
      if (created && (created.kind === "promo" || transactionSignature)) {
        setPending({ orderId: created.orderId, kind: created.kind, ...(transactionSignature ? { transactionSignature } : {}) });
        setStage("paymentPending");
      } else if (stage !== "ready") setStage("order");
    }
  }

  async function retryVerification() {
    if (!pending) return;
    setError("");
    setStage("verifying");
    try {
      const verified = await verifyOrder(pending);
      setOrderId(pending.orderId);
      setLicenseId(verified.licenseId);
      const verifiedOrderId = pending.orderId;
      setPending(null);
      await authorizeInstaller(verifiedOrderId);
    } catch (cause) {
      setError(messageOf(cause));
      setStage("paymentPending");
    }
  }

  async function authorizeInstaller(verifiedOrderId: string) {
    if (!wallet || !account || !session || account.address !== authorizedWallet) throw new Error("Reconnect the wallet that paid for this license.");
    setStage("installerProof");
    const challenge = await request<{ challengeId: string; message: string }>("POST", "/v1/web/wizard/challenge", session.browserToken, {
      sessionId: session.sessionId, orderId: verifiedOrderId, wallet: account.address
    });
    const signature = await signExactMessage(wallet, account, new TextEncoder().encode(challenge.message));
    const access = await request<{ webInstallerToken: string; licenseId: string }>("POST", "/v1/web/wizard/verify", session.browserToken, {
      challengeId: challenge.challengeId, signature: bs58.encode(signature)
    });
    setLicenseId(access.licenseId);
    const authorizedRelease = await request<ReleaseAccess>("GET", "/v1/releases/stable", access.webInstallerToken);
    setRelease(authorizedRelease);
    setStage("ready");
  }

  async function verifyOrder(value: Pending) {
    return request<{ verified: true; licenseId: string }>("POST", `/v1/orders/${encodeURIComponent(value.orderId)}/verify`, walletToken,
      value.transactionSignature ? { transactionSignature: value.transactionSignature } : {});
  }

  async function sendPayment(order: Order): Promise<string> {
    if (!wallet || !account || account.address !== authorizedWallet) throw new Error("Reconnect and authorize the paying wallet.");
    const rpc = createSolanaRpc(mainnet(solanaRpcUrl()));
    const { value: lifetime } = await rpc.getLatestBlockhash({ commitment: "confirmed" }).send();
    const transaction = await buildPaymentTransaction({
      payer: account.address, reference: order.reference, orderId: order.orderId,
      blockhash: lifetime.blockhash, lastValidBlockHeight: lifetime.lastValidBlockHeight
    });
    return bs58.encode(await signAndSendMainnetTransaction(wallet, account, transaction));
  }

  return <section className="wizard-card">
    <div className="wizard-heading"><span className="section-label">{compatibilityCheckerOnly ? "COMPATIBILITY CHECK" : earlyAccessFree ? "FREE FOREVER" : "WEBUSB ALPHA"}</span><h1>{compatibilityCheckerOnly ? "Check your PSG1." : "Revive in your browser."}</h1><p>{compatibilityCheckerOnly ? "This public checker runs a read-only USB scan. It does not unlock, wipe, flash, or bind your PSG1." : "Nothing is installed on your computer. The compatibility scan is free and does not unlock, wipe, or flash your PSG1."}</p></div>

    {!browserReady && <div className="blocked"><strong>Desktop Chrome or Edge required</strong><p>WebUSB is unavailable in this browser. Open this page in current Chrome or Edge on macOS or Windows.</p></div>}
    {!API && <div className="blocked"><strong>API not configured</strong><p>The secure Revive API is not available, so scanning cannot begin.</p></div>}

    {stage === "intro" && <div className="wizard-step"><Step number="1" title="Free hardware scan" /><p>Connect the powered-on PSG1 with USB debugging authorized. Chrome/Edge will ask you to select it once in Android and again after it reboots to Fastboot.</p><button className="button primary wide" disabled={!browserReady || !API} onClick={scanDevice}>Connect and scan PSG1</button><small>Keep the cable connected. Only read-only Fastboot queries and a normal reboot are used.</small>{developmentHardwareFixture && <div className="fixture-card"><strong>Developer fixture · localhost only</strong><p>Run the complete entitlement flow with a deterministic simulated stock, locked PSG1. It cannot unlock, wipe, flash, or download firmware.</p><button className="button ghost wide" disabled={!API} onClick={simulateStockDevice}>Simulate stock PSG1</button></div>}</div>}
    {stage === "adb" && <Progress title="Reading PSG1 hardware and firmware…" />}
    {stage === "bootloader" && <Progress title="Rebooting to the bootloader…" />}
    {stage === "fastbootReady" && <div className="wizard-step"><Step number="2" title="Continue in Fastboot" /><p>The PSG1 has changed USB modes. Chrome requires a fresh click before it can show the second device chooser.</p><button className="button primary wide" onClick={continueFastbootScan}>Select PSG1 Fastboot device</button><small>Select the PSG1 in the browser prompt. Revive will run read-only queries and then reboot it to Android.</small></div>}
    {stage === "fastboot" && <Progress title="Select the PSG1 Fastboot device in the browser prompt…" />}
    {stage === "session" && <Progress title="Cross-checking device identity and signed compatibility profiles…" />}

    {scan && <><div className="scan-summary"><span>{scan.installationState === "development_fixture" ? "Simulated PSG1" : "PSG1 detected"}</span><span>{scan.model || scan.product}</span><span>Battery {scan.batteryPercent}%</span><span>CPU ↔ Fastboot identity ✓</span><span>{stateLabel(scan.installationState)}</span></div>{!scan.fastbootUsbDescriptorVerified && <div className="descriptor-advisory"><strong>Browser descriptor advisory</strong><p>The browser returned a cached mode-specific USB serial. The authoritative Rockchip CPU and Fastboot protocol identities matched; this advisory is retained in the compatibility record.</p></div>}{scan.installationState === "already_modified" && <div className="test-mode"><strong>Already-unlocked test lane</strong><p>This PSG1 is running a modified system image. Revive can test detection, device binding, entitlement, and diagnostics, but the API will reject destructive installation-start operations.</p></div>}{scan.installationState === "development_fixture" && <div className="test-mode"><strong>Simulation—not a hardware result</strong><p>This deterministic fixture exercises the web and API state machine only. It does not count as a real compatibility or flashing test.</p></div>}</>}

    {stage === "intro" && scan && !session && <div className="pending"><strong>Hardware scan saved</strong><p>Retry the secure API session without reconnecting or rebooting the PSG1.</p><button className="button primary wide" onClick={retrySecureSession}>Retry secure session</button></div>}

    {stage === "unsupported" && <div className="blocked"><strong>This firmware is not supported yet</strong><p>The PSG1 was returned to Android. It was not charged, bound, unlocked, wiped, or flashed. Browser unlock and flashing are not public yet.</p></div>}

    {stage === "compatible" && <div className="success"><strong>✓ Compatible for a future Revive unlock</strong><p>Your PSG1 passed the signed profile and preflight checks. The browser installer is not public yet, so nothing was activated, bound, unlocked, wiped, or flashed.</p><small>Follow Revive on Discord for unlock availability. Donations are optional and never affect compatibility results.</small></div>}

    {!compatibilityCheckerOnly && stage === "freeAccess" && <div className="wizard-step"><Step number="2" title="Activate free access" /><div className="early-access-card"><strong>Free forever</strong><p>No wallet, payment, promo code, or purchase is required. Access remains bound to this PSG1 so future reinstalls can recognize it.</p></div><button className="button primary wide" onClick={activateEarlyAccess}>{scan?.installationState === "stock_locked" ? "Start unlocking — free forever" : "Continue safe test — free forever"}</button><small>Donations are optional and never affect compatibility or installer access.</small></div>}
    {!compatibilityCheckerOnly && stage === "activatingFree" && <Progress title="Activating free device access…" />}

    {!compatibilityCheckerOnly && !earlyAccessFree && stage === "wallet" && <div className="wizard-step"><Step number="2" title="Connect the paying wallet" /><p>Phantom and Solflare are supported through Solana Wallet Standard. The extension must be installed in this same browser.</p>{wallets.length ? <div className="wallet-list">{wallets.map((candidate) => <button className={`button ${wallet?.name === candidate.name ? "primary" : "ghost"}`} key={candidate.name} onClick={() => chooseWallet(candidate)}>{wallet?.name === candidate.name ? "Connected: " : "Connect "}{candidate.name}</button>)}</div> : <div className="pending"><strong>No compatible wallet found</strong><p>Install or unlock Phantom or Solflare, then reload this page.</p></div>}{account && <><p className="wallet-account">Account <code>{shortAddress(account.address)}</code></p><button className="button primary wide" onClick={authorizeCheckout}>Sign checkout authorization</button></>}</div>}
    {!compatibilityCheckerOnly && stage === "authorize" && <Progress title="Confirm the non-transaction authorization message…" />}
    {!compatibilityCheckerOnly && stage === "order" && <div className="wizard-step"><Step number="3" title="License this PSG1" /><div className="order-summary"><span>Permanent device license</span><strong>{LICENSE_PRICE_LABEL} USDC</strong><small>Solana mainnet · official USDC mint · released updates included</small></div><label className="field">Private beta invite (optional)<input value={promo} onChange={(event) => setPromo(event.target.value)} placeholder="rpb_…" autoComplete="off" spellCheck={false} /></label><button className="button primary wide" disabled={!promo.trim() && !canCreatePaidOrder} onClick={createOrder}>{promo.trim() ? "Redeem beta invite" : canCreatePaidOrder ? `Pay ${Number(LICENSE_PRICE_USDC)} USDC` : "Public sales are not open"}</button><small>Normal refunds remain available until the first destructive command begins. The current WebUSB alpha does not issue that command.</small></div>}
    {!compatibilityCheckerOnly && (stage === "paying" || stage === "verifying") && <Progress title={stage === "paying" ? "Confirm the exact USDC payment…" : "Waiting for finalized Solana verification—do not pay again…"} />}
    {!compatibilityCheckerOnly && stage === "paymentPending" && <div className="pending"><strong>Verification is incomplete</strong><p>If your wallet shows a transaction, do not pay again. Retry the same order.</p><button className="button primary wide" onClick={retryVerification}>Retry verification</button></div>}
    {!compatibilityCheckerOnly && stage === "installerProof" && <Progress title="Sign once more to prove you control the wallet that paid…" />}
    {!compatibilityCheckerOnly && stage === "ready" && <div className="success"><strong>✓ {scan?.installationState === "development_fixture" ? "Development flow completed" : earlyAccessFree ? "Free forever access activated" : "Web installer access authorized"}</strong><p>{scan?.installationState === "already_modified" ? "Your already-unlocked PSG1 completed the safe identity, entitlement, and release-access test. Destructive installation is blocked for this session." : scan?.installationState === "development_fixture" ? "The deterministic stock simulation completed. No hardware was accessed and destructive actions remain impossible." : "The device entitlement and signed release are valid. Destructive browser flashing remains disabled in this alpha until all PSG1 USB modes pass the Mac and Windows safety cohort."}</p><dl className="receipt"><dt>Access</dt><dd>{licenseId}</dd><dt>Activation</dt><dd>{orderId}</dd><dt>Release</dt><dd>{release?.manifest?.version ?? "authorized"}</dd></dl><small>Your short-lived installer token was kept only in memory and has not been stored in the browser.</small></div>}

    {error && <p className="error" role="alert">{error}</p>}
    <div className="checkout-security"><span>Read-only scan first</span><span>{compatibilityCheckerOnly ? "No unlock or flashing yet" : earlyAccessFree ? "Free forever" : "Payer signature required"}</span><span>{compatibilityCheckerOnly ? "No device binding" : "Device-bound access"}</span></div>
  </section>;
}

function postScanStage(supported: boolean, compatibilityCheckerOnly: boolean, earlyAccessFree: boolean): Stage {
  if (!supported) return "unsupported";
  if (compatibilityCheckerOnly) return "compatible";
  return earlyAccessFree ? "freeAccess" : "wallet";
}

function Step({ number, title }: { number: string; title: string }) { return <div className="step-title"><b>{number}</b><h2>{title}</h2></div>; }
function Progress({ title }: { title: string }) { return <p className="status">{title}</p>; }

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
      installationState: scan.installationState,
      androidApiLevel: scan.androidApiLevel, vendorApiLevel: scan.vendorApiLevel,
      batteryPercent: scan.batteryPercent, charging: scan.charging,
      serialVerified: scan.serialVerified, usbStable: scan.usbStable,
      immutableSerialVerified: scan.immutableSerialVerified,
      fastbootUsbDescriptorVerified: scan.fastbootUsbDescriptorVerified,
      recoveryCapable: scan.recoveryCapable, hostBytesAvailable: scan.hostBytesAvailable,
      systemPartitionBytes: scan.systemPartitionBytes,
      superPartitionBytes: scan.superPartitionBytes
    }
  });
}

function stateLabel(state: WebCompatibilityScan["installationState"]): string {
  if (state === "stock_locked") return "Stock · locked";
  if (state === "stock_unlocked") return "Stock · already unlocked";
  if (state === "already_modified") return "Modified OS · safe test";
  return "Development fixture";
}

function assertSafeOrder(order: Order) {
  if (!order.orderId || Date.parse(order.expiresAt) <= Date.now()) throw new Error("The order is invalid or expired.");
  address(order.reference);
  if (order.kind === "paid" && (order.treasury !== TREASURY_WALLET || order.mint !== SOLANA_USDC_MINT || order.amountBaseUnits !== USDC_AMOUNT_BASE_UNITS.toString())) {
    throw new Error("The API returned unexpected payment details. No transaction was created.");
  }
  if (order.kind === "promo" && order.amountBaseUnits !== "0") throw new Error("The beta order details are invalid.");
}

class ApiError extends Error { constructor(readonly code: string, message: string) { super(message); } }
async function request<T>(method: "GET" | "POST", path: string, token: string, body?: unknown): Promise<T> {
  if (!API) throw new Error("The secure API is not configured.");
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), 20_000);
  try {
    const response = await fetch(`${API}${path}`, {
      method, cache: "no-store", signal: controller.signal,
      headers: { ...(body === undefined ? {} : { "content-type": "application/json" }), ...(token ? { authorization: `Bearer ${token}` } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) })
    });
    const value = await response.json().catch(() => ({})) as { code?: string; message?: string };
    if (!response.ok) throw new ApiError(value.code ?? "REQUEST_FAILED", value.message ?? value.code ?? "Request failed");
    return value as T;
  } finally { window.clearTimeout(timeout); }
}

const ERROR_MESSAGES: Record<string, string> = {
  UNSUPPORTED_FIRMWARE: "This firmware is not supported. No charge or modification was performed.",
  PUBLIC_SALES_DISABLED: "Public sales are not open. An approved private-beta invite is required.",
  BETA_INVITE_INVALID: "That beta invite is invalid, expired, or belongs to a different PSG1.",
  PAYMENT_ALREADY_USED_OR_DEVICE_LICENSED: "The transaction or device license has already been used.",
  PAID_ORDER_NOT_FOUND: "A finalized paid order for this wallet and PSG1 was not found.",
  ACTIVE_LICENSE_REQUIRED: "The device license is not active.",
  WALLET_SIGNATURE_INVALID: "The wallet signature could not be verified.",
  NO_STABLE_RELEASE: "No signed stable release is available for this PSG1 profile yet.",
  COMPATIBILITY_CHECKER_ONLY: "The public compatibility checker is live. Browser unlock and flashing are not open yet.",
  EARLY_ACCESS_DISABLED: "Free access is no longer accepting new activations.",
  DEVELOPMENT_FIXTURE_FORBIDDEN: "The stock simulator is available only on localhost when both services explicitly enable it.",
  DESTRUCTIVE_TEST_MODE_BLOCKED: "Destructive installation is intentionally blocked for simulated or already-modified devices."
};
function messageOf(cause: unknown) {
  if (cause instanceof ApiError) return ERROR_MESSAGES[cause.code] ?? cause.message;
  if (cause instanceof DOMException && cause.name === "NotFoundError") return "No USB device was selected. The PSG1 was not modified.";
  if ((cause instanceof DOMException && cause.name === "SecurityError") || (cause instanceof Error && /permissions policy|feature ["']?usb["']? is disallowed/iu.test(cause.message))) {
    return "WebUSB is blocked by this page or browser window. Open the wizard directly in a top-level Chrome or Edge tab (not an embedded preview), then reload it.";
  }
  if (cause instanceof Error) return /(?:user (?:rejected|declined)|request (?:was )?cancelled)/iu.test(cause.message) ? "The request was cancelled. No device modification was made." : cause.message;
  return "The wizard stopped safely before making another change.";
}
function desktopChromium() { return !/Android|iPhone|iPad|iPod/iu.test(navigator.userAgent) && /Chrome|Chromium|Edg/iu.test(navigator.userAgent); }
function subscribeBrowserCapability() { return () => undefined; }
function browserCapabilitySnapshot() { return WebAdbPsg1.supported() && desktopChromium(); }
function base64Url(bytes: Uint8Array) { let binary = ""; for (const byte of bytes) binary += String.fromCharCode(byte); return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, ""); }
function shortAddress(value: string) { return `${value.slice(0, 5)}…${value.slice(-5)}`; }
