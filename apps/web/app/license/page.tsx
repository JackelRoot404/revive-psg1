import Link from "next/link";
import { isEarlyAccessFree } from "../../lib/server-config";

export const metadata = { title: "License status" };

export default function LicenseStatus() {
  const earlyAccessFree = isEarlyAccessFree();
  return <main className="prose">
    <span className="section-label">{earlyAccessFree ? "FREE EARLY ACCESS" : "DEVICE-BOUND ACCESS"}</span>
    <h1>{earlyAccessFree ? "Early Access is free." : "Recover your license."}</h1>
    {earlyAccessFree ? <>
      <p>This project is currently free during Early Access. Donations are optional and greatly appreciated. Paid licensing may return once the project reaches a stable v1.0.</p>
      <div className="notice"><strong>No purchase or wallet required.</strong><p>Connect a supported PSG1, complete the read-only compatibility scan, and activate device-bound access instantly.</p></div>
      <p><Link className="button primary inline-button" href="/wizard">Start Unlocking — Free</Link></p>
    </> : <p>Revive licenses the physical PSG1, not the wallet or computer. Reconnect the licensed handheld and run the free web scan. A factory reset, OS reinstall, or different computer does not consume another license.</p>}
    <div className="notice"><strong>Access follows the PSG1.</strong><p>Factory resets, Android reinstalls, changing wallets, and moving to another computer do not consume another device activation.</p></div>
    <h2>Why the PSG1 must be connected</h2>
    <p>The website does not accept typed device serials, recovery credentials, license tokens, or manually entered transaction signatures. The web wizard derives the hashed device ID only after it cross-checks the physical PSG1 in ADB, USB, and Fastboot. A device hash alone cannot issue installer access.</p>
    <h2>If recovery fails</h2>
    <ol><li>Use a data-capable USB cable and power on the PSG1.</li><li>Accept the ADB prompt if Android displays one.</li><li>Run the read-only scan again and save the redacted support report.</li></ol>
    <p><Link className="text-link" href="/docs">Read the installation guide →</Link></p>
  </main>;
}
