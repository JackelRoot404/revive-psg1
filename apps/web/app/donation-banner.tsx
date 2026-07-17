"use client";

import { useEffect, useRef, useState } from "react";
import QRCode from "qrcode";
import { TREASURY_WALLET } from "@revive-psg1/contracts";

const SOLSCAN_URL = `https://solscan.io/account/${TREASURY_WALLET}`;

export function DonationBanner() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!canvasRef.current) return;
    void QRCode.toCanvas(canvasRef.current, TREASURY_WALLET, {
      width: 176,
      margin: 1,
      errorCorrectionLevel: "M",
      color: { dark: "#080b0a", light: "#ffffff" }
    });
  }, []);

  useEffect(() => {
    if (!copied) return;
    const timeout = window.setTimeout(() => setCopied(false), 2_600);
    return () => window.clearTimeout(timeout);
  }, [copied]);

  async function copyAddress() {
    try {
      await navigator.clipboard.writeText(TREASURY_WALLET);
    } catch {
      const input = document.createElement("textarea");
      input.value = TREASURY_WALLET;
      input.setAttribute("readonly", "");
      input.style.position = "fixed";
      input.style.opacity = "0";
      document.body.append(input);
      input.select();
      const copiedWithFallback = document.execCommand("copy");
      input.remove();
      if (!copiedWithFallback) throw new Error("Clipboard copy was rejected");
    }
    setCopied(true);
  }

  return <section className="donation-banner" aria-labelledby="donation-title">
    <div className="donation-inner">
      <div className="donation-copy">
        <span className="donation-kicker">COMMUNITY-SUPPORTED EARLY ACCESS</span>
        <h2 id="donation-title">❤️ Early Access is FREE</h2>
        <p>Revive PSG1 is currently available at no cost while the project matures.</p>
        <p>If this project saved your console—or you simply want to support future development—please consider donating. Every donation directly funds new features, bug fixes, compatibility improvements, and long-term maintenance.</p>
        <div className="donation-wallet"><span>Solana wallet</span><code>{TREASURY_WALLET}</code></div>
        <div className="donation-actions">
          <button className="button donation-primary" type="button" onClick={copyAddress}>Copy Wallet Address</button>
          <a className="button donation-secondary" href={SOLSCAN_URL} target="_blank" rel="noreferrer">View on Solscan ↗</a>
        </div>
      </div>
      <div className="donation-qr">
        <canvas ref={canvasRef} role="img" aria-label={`QR code for Solana donation wallet ${TREASURY_WALLET}`} />
        <span>SCAN TO COPY WALLET</span>
      </div>
    </div>
    <div className={`copy-toast ${copied ? "visible" : ""}`} role="status" aria-live="polite" aria-hidden={!copied}>
      <span>✓</span><div><strong>Wallet copied</strong><small>Paste it into your Solana wallet.</small></div>
    </div>
  </section>;
}
