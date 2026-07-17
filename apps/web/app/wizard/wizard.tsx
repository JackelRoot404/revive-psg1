"use client";

import { useEffect, useState, useSyncExternalStore } from "react";
import type { WalletAccount } from "@wallet-standard/base";
import { address, createSolanaRpc, mainnet } from "@solana/kit";
import {
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

type Stage = "intro" | "adb" | "bootloader" | "fastboot" | "session" | "unsupported" | "wallet" | "authorize" | "order" | "paying" | "verifying" | "paymentPending" | "installerProof" | "ready";
type Session = { sessionId: string; supported: boolean; browserToken: string; profileId: string | null; expiresAt: string };
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

export function Wizard() {
  const [stage, setStage] = useState<Stage>("intro");
  const [scan, setScan] = useState<WebCompatibilityScan | null>(null);
  const [session, setSession] = useState<Session | null>(null);
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

  useEffect(() => watchCompatibleWallets(setWallets), []);
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
    let fastboot: WebFastbootPsg1 | null = null;
    let fastbootRebooted = false;
    try {
      adb = await WebAdbPsg1.request();
      const adbSerial = adb.normalizedSerial;
      const snapshot = await adb.readCompatibility();
      if (!snapshot.usbStable) throw new Error("The PSG1 USB connection was not stable enough for a safe scan.");
      setStage("bootloader");
      await adb.rebootBootloader();
      await adb.close().catch(() => undefined);
      adb = null;
      setStage("fastboot");
      fastboot = await WebFastbootPsg1.request();
      const completed = await finalizeWebScan(snapshot, adbSerial, fastboot);
      setScan(completed);
      setStage("session");
      const created = await createWebSession(completed);
      setSession(created);
      await fastboot.reboot();
      fastbootRebooted = true;
      await fastboot.close().catch(() => undefined);
      fastboot = null;
      setStage(created.supported ? "wallet" : "unsupported");
    } catch (cause) {
      setError(messageOf(cause));
      setStage("intro");
    } finally {
      await adb?.close().catch(() => undefined);
      if (fastboot && !fastbootRebooted) await fastboot.reboot().catch(() => undefined);
      await fastboot?.close().catch(() => undefined);
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
    <div className="wizard-heading"><span className="section-label">WEBUSB ALPHA</span><h1>Revive in your browser.</h1><p>Nothing is installed on your computer. The free scan runs before checkout and does not unlock, wipe, or flash your PSG1.</p></div>

    {!browserReady && <div className="blocked"><strong>Desktop Chrome or Edge required</strong><p>WebUSB is unavailable in this browser. Open this page in current Chrome or Edge on macOS or Windows.</p></div>}
    {!API && <div className="blocked"><strong>API not configured</strong><p>The secure Revive API is not available, so scanning cannot begin.</p></div>}

    {stage === "intro" && <div className="wizard-step"><Step number="1" title="Free hardware scan" /><p>Connect the powered-on PSG1 with USB debugging authorized. Chrome/Edge will ask you to select it once in Android and again after it reboots to Fastboot.</p><button className="button primary wide" disabled={!browserReady || !API} onClick={scanDevice}>Connect and scan PSG1</button><small>Keep the cable connected. Only read-only Fastboot queries and a normal reboot are used.</small></div>}
    {stage === "adb" && <Progress title="Reading PSG1 hardware and firmware…" />}
    {stage === "bootloader" && <Progress title="Rebooting to the bootloader…" />}
    {stage === "fastboot" && <Progress title="Select the PSG1 Fastboot device in the browser prompt…" />}
    {stage === "session" && <Progress title="Cross-checking device identity and signed compatibility profiles…" />}

    {scan && <div className="scan-summary"><span>PSG1 detected</span><span>{scan.model || scan.product}</span><span>Battery {scan.batteryPercent}%</span><span>Serial cross-check ✓</span></div>}

    {stage === "unsupported" && <div className="blocked"><strong>This firmware is not supported yet</strong><p>The PSG1 was returned to Android. It was not charged, bound, unlocked, wiped, or flashed.</p></div>}

    {stage === "wallet" && <div className="wizard-step"><Step number="2" title="Connect the paying wallet" /><p>Phantom and Solflare are supported through Solana Wallet Standard. The extension must be installed in this same browser.</p>{wallets.length ? <div className="wallet-list">{wallets.map((candidate) => <button className={`button ${wallet?.name === candidate.name ? "primary" : "ghost"}`} key={candidate.name} onClick={() => chooseWallet(candidate)}>{wallet?.name === candidate.name ? "Connected: " : "Connect "}{candidate.name}</button>)}</div> : <div className="pending"><strong>No compatible wallet found</strong><p>Install or unlock Phantom or Solflare, then reload this page.</p></div>}{account && <><p className="wallet-account">Account <code>{shortAddress(account.address)}</code></p><button className="button primary wide" onClick={authorizeCheckout}>Sign checkout authorization</button></>}</div>}
    {stage === "authorize" && <Progress title="Confirm the non-transaction authorization message…" />}
    {stage === "order" && <div className="wizard-step"><Step number="3" title="License this PSG1" /><div className="order-summary"><span>Permanent device license</span><strong>29.00 USDC</strong><small>Solana mainnet · official USDC mint · released updates included</small></div><label className="field">Private beta invite (optional)<input value={promo} onChange={(event) => setPromo(event.target.value)} placeholder="rpb_…" autoComplete="off" spellCheck={false} /></label><button className="button primary wide" disabled={!promo.trim() && !canCreatePaidOrder} onClick={createOrder}>{promo.trim() ? "Redeem beta invite" : canCreatePaidOrder ? "Pay 29 USDC" : "Public sales are not open"}</button><small>Normal refunds remain available until the first destructive command begins. The current WebUSB alpha does not issue that command.</small></div>}
    {(stage === "paying" || stage === "verifying") && <Progress title={stage === "paying" ? "Confirm the exact USDC payment…" : "Waiting for finalized Solana verification—do not pay again…"} />}
    {stage === "paymentPending" && <div className="pending"><strong>Verification is incomplete</strong><p>If your wallet shows a transaction, do not pay again. Retry the same order.</p><button className="button primary wide" onClick={retryVerification}>Retry verification</button></div>}
    {stage === "installerProof" && <Progress title="Sign once more to prove you control the wallet that paid…" />}
    {stage === "ready" && <div className="success"><strong>✓ Web installer access authorized</strong><p>The device license and signed release are valid. Destructive browser flashing remains disabled in this alpha until all PSG1 USB modes pass the Mac and Windows safety cohort.</p><dl className="receipt"><dt>License</dt><dd>{licenseId}</dd><dt>Order</dt><dd>{orderId}</dd><dt>Release</dt><dd>{release?.manifest?.version ?? "authorized"}</dd></dl><small>Your short-lived installer token was kept only in memory and has not been stored in the browser.</small></div>}

    {error && <p className="error" role="alert">{error}</p>}
    <div className="checkout-security"><span>Read-only scan first</span><span>Payer signature required</span><span>Device-bound license</span></div>
  </section>;
}

function Step({ number, title }: { number: string; title: string }) { return <div className="step-title"><b>{number}</b><h2>{title}</h2></div>; }
function Progress({ title }: { title: string }) { return <p className="status">{title}</p>; }

async function createWebSession(scan: WebCompatibilityScan): Promise<Session> {
  const keyPair = nacl.sign.keyPair();
  const pairingPublicKey = bs58.encode(keyPair.publicKey);
  const requestNonce = base64Url(crypto.getRandomValues(new Uint8Array(32)));
  const createdAt = new Date().toISOString();
  const proofInput = { deviceId: scan.deviceId, pairingPublicKey, appVersion: WEB_VERSION, requestNonce, createdAt };
  const pairingProof = bs58.encode(nacl.sign.detached(new TextEncoder().encode(webSessionProofMessage(proofInput)), keyPair.secretKey));
  return request<Session>("POST", "/v1/web/sessions", "", {
    ...proofInput, pairingProof, hostOs: "web",
    compatibility: {
      product: scan.product, model: scan.model, board: scan.board, hardware: scan.hardware,
      buildFingerprint: scan.buildFingerprint, buildIncremental: scan.buildIncremental,
      androidApiLevel: scan.androidApiLevel, vendorApiLevel: scan.vendorApiLevel,
      batteryPercent: scan.batteryPercent, charging: scan.charging,
      serialVerified: scan.serialVerified, usbStable: scan.usbStable,
      recoveryCapable: scan.recoveryCapable, hostBytesAvailable: scan.hostBytesAvailable,
      systemPartitionBytes: scan.systemPartitionBytes
    }
  });
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
  NO_STABLE_RELEASE: "No signed stable release is available for this PSG1 profile yet."
};
function messageOf(cause: unknown) {
  if (cause instanceof ApiError) return ERROR_MESSAGES[cause.code] ?? cause.message;
  if (cause instanceof DOMException && cause.name === "NotFoundError") return "No USB device was selected. The PSG1 was not modified.";
  if (cause instanceof Error) return /reject|declin|cancel/iu.test(cause.message) ? "The request was cancelled. No new payment or modification was made." : cause.message;
  return "The wizard stopped safely before making another change.";
}
function desktopChromium() { return !/Android|iPhone|iPad|iPod/iu.test(navigator.userAgent) && /Chrome|Chromium|Edg/iu.test(navigator.userAgent); }
function subscribeBrowserCapability() { return () => undefined; }
function browserCapabilitySnapshot() { return WebAdbPsg1.supported() && desktopChromium(); }
function base64Url(bytes: Uint8Array) { let binary = ""; for (const byte of bytes) binary += String.fromCharCode(byte); return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, ""); }
function shortAddress(value: string) { return `${value.slice(0, 5)}…${value.slice(-5)}`; }
