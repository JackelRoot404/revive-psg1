"use client";

import { useEffect, useMemo, useState } from "react";
import type { WalletAccount } from "@wallet-standard/base";
import { address, createSolanaRpc, mainnet } from "@solana/kit";
import bs58 from "bs58";
import { SOLANA_USDC_MINT, TREASURY_WALLET, USDC_AMOUNT_BASE_UNITS } from "@revive-psg1/contracts";
import { apiUrl, SAME_COMPUTER_PAIRING_IMPLEMENTED, solanaRpcUrl } from "../../../lib/public-config";
import { buildPaymentTransaction } from "../../../lib/payment-transaction";
import {
  compatibleWallets,
  connectWallet as connectStandardWallet,
  isUsableMainnetAccount,
  signAndSendMainnetTransaction,
  signExactMessage,
  watchCompatibleWallets,
  watchWalletAccounts,
  type ReviveWallet
} from "../../../lib/solana-wallet";

const API = apiUrl();

type Stage = "initializing" | "proof" | "proofRequest" | "proofWaiting" | "wallet" | "authorize" | "order" | "paying" | "verifying" | "paymentPending" | "complete";
type Order = {
  orderId: string;
  kind: "paid" | "promo";
  reference: string;
  amountBaseUnits: string;
  treasury: string;
  mint: string;
  expiresAt: string;
};
type PendingVerification = Pick<Order, "orderId" | "kind"> & { transactionSignature?: string };
type Receipt = {
  kind: "paid" | "promo" | "restored";
  orderId?: string;
  licenseId?: string;
  transactionSignature?: string;
  wallet?: string;
};

export function Checkout({ sessionId }: { sessionId: string }) {
  const [wallets, setWallets] = useState<ReviveWallet[]>([]);
  const [selectedWallet, setSelectedWallet] = useState<ReviveWallet | null>(null);
  const [selectedAccount, setSelectedAccount] = useState<WalletAccount | null>(null);
  const [checkoutToken, setCheckoutToken] = useState("");
  const [browserToken, setBrowserToken] = useState("");
  const [walletToken, setWalletToken] = useState("");
  const [authorizedWallet, setAuthorizedWallet] = useState("");
  const [stage, setStage] = useState<Stage>("initializing");
  const [promo, setPromo] = useState("");
  const [error, setError] = useState("");
  const [pending, setPending] = useState<PendingVerification | null>(null);
  const [receipt, setReceipt] = useState<Receipt | null>(null);

  const tokenStorageKey = `revive-checkout-token:${sessionId}`;
  const nonceStorageKey = `revive-browser-nonce:${sessionId}`;
  const challengeStorageKey = `revive-browser-challenge:${sessionId}`;

  useEffect(() => watchCompatibleWallets(setWallets), []);

  useEffect(() => {
    if (!selectedWallet) return;
    return watchWalletAccounts(selectedWallet, (accounts) => {
      setSelectedAccount((selected) => {
        const current = selected && accounts.find((account) => account.address === selected.address && isUsableMainnetAccount(account));
        return current ?? accounts.find(isUsableMainnetAccount) ?? null;
      });
    });
  }, [selectedWallet]);

  useEffect(() => {
    if (!selectedWallet || wallets.some((wallet) => wallet === selectedWallet)) return;
    // Removing or disabling an extension invalidates every authorization tied to it.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setSelectedWallet(null);
    setSelectedAccount(null);
    setWalletToken("");
    setAuthorizedWallet("");
    setPending(null);
    setStage("wallet");
  }, [selectedWallet, wallets]);

  useEffect(() => {
    const fragment = new URLSearchParams(location.hash.slice(1));
    const incomingToken = fragment.get("token") ?? "";
    const storedToken = sessionStorage.getItem(tokenStorageKey) ?? "";
    const token = incomingToken || storedToken;
    if (incomingToken) sessionStorage.setItem(tokenStorageKey, incomingToken);
    history.replaceState(null, "", location.pathname);
    // Hydrate the one-use fragment into component state after the browser mounts.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setCheckoutToken(token);
    if (token) {
      const existingNonce = sessionStorage.getItem(nonceStorageKey);
      const existingChallenge = sessionStorage.getItem(challengeStorageKey);
      if (existingNonce && existingChallenge) {
        setStage("proofWaiting");
        // This named function is stable for the lifetime of this mounted checkout.
        // eslint-disable-next-line react-hooks/immutability
        void pollBrowserProof(token, existingChallenge, existingNonce);
      } else setStage("proof");
    }
    else setStage("wallet");
    // The checkout token is intentionally captured only once from the URL fragment.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [challengeStorageKey, nonceStorageKey, tokenStorageKey]);

  useEffect(() => {
    const connected = selectedAccount?.address;
    if (!authorizedWallet || !connected || connected === authorizedWallet || stage === "complete") return;
    // A changed external wallet invalidates every authorization derived from the old wallet.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setWalletToken("");
    setAuthorizedWallet("");
    setPending(null);
    setError("The connected wallet changed. Authorize the checkout again before creating a transaction.");
    setStage("wallet");
  }, [authorizedWallet, selectedAccount, stage]);

  const configurationError = useMemo(() => {
    if (process.env.NODE_ENV !== "development" && !SAME_COMPUTER_PAIRING_IMPLEMENTED) return "Checkout is intentionally disabled until the signed desktop-local pairing proof passes its security tests.";
    if (!API) return "Checkout is unavailable because the production API URL is not configured securely.";
    if (stage !== "initializing" && !checkoutToken && !browserToken && !walletToken) return "This checkout link is missing or has already been opened. Return to Revive Desktop and start checkout again.";
    return null;
  }, [browserToken, checkoutToken, stage, walletToken]);

  async function beginBrowserProof() {
    if (!checkoutToken || !API || configurationError) return;
    setError("");
    setStage("proofRequest");
    try {
      const browserNonce = randomBrowserNonce();
      const challenge = await api<{ challengeId?: string; message?: string }>(
        `/v1/sessions/${encodeURIComponent(sessionId)}/browser-proof/challenge`, checkoutToken, { browserNonce }
      );
      if (!challenge.challengeId || !challenge.message) throw new Error("The desktop proof challenge was incomplete.");
      sessionStorage.setItem(nonceStorageKey, browserNonce);
      sessionStorage.setItem(challengeStorageKey, challenge.challengeId);
      const encodedMessage = base64Url(new TextEncoder().encode(challenge.message));
      const deepLink = new URL("revive-psg1://browser-proof");
      deepLink.searchParams.set("message", encodedMessage);
      setStage("proofWaiting");
      void pollBrowserProof(checkoutToken, challenge.challengeId, browserNonce);
      location.href = deepLink.toString();
    } catch (cause) {
      setError(messageOf(cause));
      setStage("proof");
    }
  }

  async function pollBrowserProof(token: string, challengeId: string, browserNonce: string) {
    const deadline = Date.now() + 5 * 60_000;
    while (Date.now() < deadline) {
      await new Promise((resolve) => window.setTimeout(resolve, 1_500));
      try {
        const result = await api<{ verified: boolean; browserToken?: string }>(`/v1/sessions/${encodeURIComponent(sessionId)}/browser-proof/status`, token, { challengeId, browserNonce });
        if (result.verified) {
          if (!result.browserToken) throw new Error("The API did not issue a browser-bound authorization token.");
          sessionStorage.removeItem(tokenStorageKey);
          sessionStorage.removeItem(nonceStorageKey);
          sessionStorage.removeItem(challengeStorageKey);
          setCheckoutToken("");
          setBrowserToken(result.browserToken);
          setError("");
          setStage("wallet");
          return;
        }
      } catch (cause) {
        setError(messageOf(cause));
        setStage("proof");
        return;
      }
    }
    setError("The desktop proof expired. Request a new one; no wallet transaction was created.");
    setStage("proof");
  }

  async function chooseWallet(wallet: ReviveWallet) {
    setError("");
    try {
      const account = await connectStandardWallet(wallet);
      setSelectedWallet(wallet);
      setSelectedAccount(account);
    } catch (cause) {
      setError(messageOf(cause));
    }
  }

  async function authorize() {
    if (!selectedWallet || !selectedAccount || !browserToken || !API || configurationError) return;
    setError("");
    setStage("authorize");
    try {
      const challenge = await api<{ challengeId: string; message: string }>("/v1/wallet/challenge", browserToken, {
        sessionId, wallet: selectedAccount.address
      });
      const signature = await signExactMessage(selectedWallet, selectedAccount, new TextEncoder().encode(challenge.message));
      const verified = await api<{ walletToken: string }>("/v1/wallet/verify", browserToken, {
        challengeId: challenge.challengeId, signature: bs58.encode(signature)
      });
      setAuthorizedWallet(selectedAccount.address);
      setWalletToken(verified.walletToken);
      setStage("order");
    } catch (cause) {
      setError(messageOf(cause));
      setStage("wallet");
    }
  }

  async function placeOrder() {
    if (!selectedWallet || !selectedAccount || !walletToken || configurationError) return;
    setError("");
    setStage("paying");
    let created: Order | undefined;
    let transactionSignature: string | undefined;
    try {
      const order = await api<Order & { alreadyLicensed?: boolean; licenseId?: string }>("/v1/orders", walletToken, {
        sessionId, ...(promo.trim() ? { betaInviteToken: promo.trim() } : {})
      });
      if (order.alreadyLicensed) {
        finish({ kind: "restored", ...(order.licenseId ? { licenseId: order.licenseId } : {}), wallet: selectedAccount.address });
        return;
      }
      assertSafeOrder(order);
      created = order;
      if (order.kind === "paid") transactionSignature = await sendPayment(order);
      const nextPending = { orderId: order.orderId, kind: order.kind, ...(transactionSignature ? { transactionSignature } : {}) };
      setPending(nextPending);
      setStage("verifying");
      await verify(nextPending);
      finish({ kind: order.kind, orderId: order.orderId, ...(transactionSignature ? { transactionSignature } : {}), wallet: selectedAccount.address });
    } catch (cause) {
      setError(messageOf(cause));
      if (created && (created.kind === "promo" || transactionSignature)) {
        setPending({ orderId: created.orderId, kind: created.kind, ...(transactionSignature ? { transactionSignature } : {}) });
        setStage("paymentPending");
      } else {
        setStage("order");
      }
    }
  }

  async function retryVerification() {
    if (!pending) return;
    setError("");
    setStage("verifying");
    try {
      await verify(pending);
      finish({
        kind: pending.kind,
        orderId: pending.orderId,
        ...(pending.transactionSignature ? { transactionSignature: pending.transactionSignature } : {}),
        wallet: authorizedWallet
      });
    } catch (cause) {
      setError(messageOf(cause));
      setStage("paymentPending");
    }
  }

  async function verify(value: PendingVerification) {
    await api(`/v1/orders/${value.orderId}/verify`, walletToken, value.transactionSignature
      ? { transactionSignature: value.transactionSignature }
      : {});
  }

  async function sendPayment(order: Order): Promise<string> {
    if (!selectedWallet || !selectedAccount) throw new Error("Connect a supported injected desktop wallet.");
    if (selectedAccount.address !== authorizedWallet) throw new Error("The connected wallet changed. Authorize checkout again.");
    const rpc = createSolanaRpc(mainnet(solanaRpcUrl()));
    const { value: lifetime } = await rpc.getLatestBlockhash({ commitment: "confirmed" }).send();
    const transaction = await buildPaymentTransaction({
      payer: selectedAccount.address,
      reference: order.reference,
      orderId: order.orderId,
      blockhash: lifetime.blockhash,
      lastValidBlockHeight: lifetime.lastValidBlockHeight
    });
    const signature = await signAndSendMainnetTransaction(selectedWallet, selectedAccount, transaction);
    return bs58.encode(signature);
  }

  function finish(value: Receipt) {
    setReceipt(value);
    setPending(null);
    setError("");
    setStage("complete");
  }

  const desktopUrl = receipt?.orderId
    ? `revivepsg1://activate?order=${encodeURIComponent(receipt.orderId)}`
    : receipt?.licenseId
      ? `revivepsg1://activate?license=${encodeURIComponent(receipt.licenseId)}`
      : null;

  return <section className="checkout-card">
    <span className="section-label">SECURE CHECKOUT</span><h1>License this PSG1</h1>
    <p className="muted">29 USDC · Solana mainnet · permanent device entitlement</p>
    <div className="order-summary"><span>Revive PSG1 license</span><strong>29.00 USDC</strong><small>Updates included. Bound to the connected PSG1 after verification.</small></div>

    {configurationError && stage !== "complete" && <div className="blocked" role="alert"><strong>Checkout not available</strong><p>{configurationError}</p><small>No wallet transaction has been requested.</small></div>}

    {!configurationError && stage === "proof" && <div className="proof"><strong>Verify this browser is paired</strong><p>Revive Desktop will sign a one-time challenge for this PSG1. This does not unlock, wipe, flash, or create a transaction.</p><button className="button primary wide" onClick={beginBrowserProof}>Verify with Revive Desktop</button></div>}
    {!configurationError && stage === "proofRequest" && <p className="status">Verifying the one-time desktop proof…</p>}
    {!configurationError && stage === "proofWaiting" && <div className="pending"><strong>Finish in Revive Desktop</strong><p>Keep this checkout tab open. The app sends its signed proof directly to the API; this page never receives the desktop signature.</p></div>}
    {!configurationError && stage === "wallet" && <div className="wallet-standard"><p>Connect a Wallet Standard extension injected into this desktop browser. Revive provides no mobile QR, deep-link wallet, or typed-address path.</p>{wallets.length === 0 ? <div className="pending"><strong>No compatible injected wallet found</strong><p>Install or unlock a Wallet Standard extension that supports Solana mainnet message signing and legacy transaction signing, then reload this checkout from Revive Desktop.</p></div> : <div className="wallet-list" aria-label="Compatible wallet extensions">{wallets.map((available) => <button className={`button ${selectedWallet?.name === available.name ? "primary" : "ghost"}`} key={available.name} onClick={() => chooseWallet(available)}>{selectedWallet?.name === available.name ? "Connected: " : "Connect "}{available.name}</button>)}</div>}{selectedAccount && <><p className="wallet-account">Authorized account <code>{shortAddress(selectedAccount.address)}</code></p><button className="button primary wide" onClick={authorize}>Authorize checkout</button></>}</div>}
    {!configurationError && stage === "authorize" && <p className="status">Confirm the non-transaction authorization message in your wallet…</p>}
    {!configurationError && stage === "order" && <><label className="field">Private beta invite (optional)<input value={promo} onChange={(event) => setPromo(event.target.value)} placeholder="rpb_…" autoComplete="off" spellCheck={false} /></label><button className="button primary wide" onClick={placeOrder}>{promo ? "Redeem approved beta invite" : "Pay 29 USDC"}</button><small>Beta invites are one-time and pre-approved for this PSG1. Normal refunds are available until the installer begins the first destructive operation.</small></>}
    {!configurationError && (stage === "paying" || stage === "verifying") && <p className="status">{stage === "paying" ? "Confirm the exact USDC payment in your wallet…" : "Waiting for finalized Solana verification… Do not send another payment."}</p>}
    {!configurationError && stage === "paymentPending" && <div className="pending"><strong>Payment verification is incomplete</strong><p>If your wallet shows a transaction, do not pay again. Retry verification of the same transaction.</p><button className="button primary wide" onClick={retryVerification}>Retry verification</button></div>}
    {stage === "complete" && receipt && <div className="success"><strong>✓ {receipt.kind === "restored" ? "Existing license found" : "Order verified"}</strong><p>Your device entitlement is ready. The desktop app will claim the signed license and retain the local recovery report.</p>{receipt.orderId && <dl className="receipt"><dt>Order</dt><dd>{receipt.orderId}</dd><dt>Type</dt><dd>{receipt.kind === "paid" ? "29 USDC" : "Beta seat"}</dd>{receipt.transactionSignature && <><dt>Transaction</dt><dd><a href={`https://solscan.io/tx/${encodeURIComponent(receipt.transactionSignature)}`} target="_blank" rel="noreferrer">View finalized transaction ↗</a></dd></>}</dl>}{desktopUrl && <a className="button primary wide inline-button" href={desktopUrl}>Return to Revive Desktop</a>}<small>If the button does not open the app, switch back to Revive Desktop. Do not share this page.</small></div>}
    {error && <p className="error" role="alert">{error}</p>}
    <div className="checkout-security"><span>Exact amount</span><span>Official USDC mint</span><span>Finalized on-chain</span></div>
  </section>;
}

function assertSafeOrder(order: Order) {
  if (!order.orderId || !order.expiresAt || Date.parse(order.expiresAt) <= Date.now()) throw new Error("The order is invalid or expired. Start again from Revive Desktop.");
  address(order.reference);
  if (order.kind === "paid" && (
    order.treasury !== TREASURY_WALLET
    || order.mint !== SOLANA_USDC_MINT
    || order.amountBaseUnits !== USDC_AMOUNT_BASE_UNITS.toString()
  )) throw new Error("The server returned unexpected payment details. No transaction was created.");
  if (order.kind === "promo" && order.amountBaseUnits !== "0") throw new Error("The beta order details are invalid.");
}

class ApiError extends Error {
  constructor(readonly code: string, message: string, readonly status: number) { super(message); }
}

async function api<T = unknown>(path: string, token: string, body?: unknown): Promise<T> {
  return apiRequest<T>("POST", path, token, body);
}

async function apiRequest<T>(method: "GET" | "POST", path: string, token: string, body?: unknown): Promise<T> {
  if (!API) throw new Error("The secure API is not configured.");
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), 20_000);
  try {
    const response = await fetch(`${API}${path}`, {
      method,
      headers: { ...(body === undefined ? {} : { "content-type": "application/json" }), authorization: `Bearer ${token}` },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      cache: "no-store",
      signal: controller.signal
    });
    const value = await response.json().catch(() => ({})) as { code?: string; message?: string };
    if (!response.ok) throw new ApiError(value.code ?? "REQUEST_FAILED", value.message ?? value.code ?? "Checkout request failed", response.status);
    return value as T;
  } catch (cause) {
    if (cause instanceof DOMException && cause.name === "AbortError") throw new Error("The service did not respond in time. No new payment should be sent; retry this step.");
    throw cause;
  } finally {
    window.clearTimeout(timeout);
  }
}

const ERROR_MESSAGES: Record<string, string> = {
  CHALLENGE_INVALID: "The wallet challenge expired or was already used. Start a new checkout from Revive Desktop.",
  CHALLENGE_ALREADY_USED: "That authorization was already used. Start a new checkout from Revive Desktop.",
  WALLET_SIGNATURE_INVALID: "The wallet signature could not be verified.",
  UNSUPPORTED_FIRMWARE: "This PSG1 firmware is not supported. No charge or device binding was performed.",
  PUBLIC_SALES_DISABLED: "Public sales are not open. Only an available private-beta seat can continue.",
  BETA_INVITE_INVALID: "That private-beta invite is invalid, expired, or approved for a different PSG1.",
  BETA_INVITE_INVALID_OR_USED: "That private-beta invite has expired or was already redeemed.",
  PROMO_EXHAUSTED: "All private-beta seats have been redeemed.",
  TRANSACTION_REQUIRED: "A transaction signature is required to verify this order.",
  PAYMENT_ALREADY_USED: "That transaction has already been used for another order.",
  ORDER_NOT_FOUND: "The order expired or does not belong to this wallet session. Return to Revive Desktop.",
  SESSION_MISMATCH: "The checkout session does not match this PSG1. Return to Revive Desktop.",
  LOCAL_DESKTOP_PROOF_REQUIRED: "Verify the one-time challenge with Revive Desktop before connecting a wallet.",
  REQUEST_FAILED: "Verification is temporarily unavailable. If payment was sent, do not pay again; retry verification."
};

function messageOf(cause: unknown) {
  if (cause instanceof ApiError) return ERROR_MESSAGES[cause.code] ?? cause.message;
  if (cause instanceof Error) {
    if (/reject|declin|cancel/i.test(cause.message)) return "The wallet request was cancelled. No license was created.";
    return cause.message;
  }
  return "Checkout failed. No new payment should be sent until the order status is known.";
}

function base64Url(bytes: Uint8Array) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function randomBrowserNonce() {
  return base64Url(crypto.getRandomValues(new Uint8Array(32)));
}

function shortAddress(value: string) {
  return `${value.slice(0, 5)}…${value.slice(-5)}`;
}
