import Link from "next/link";

export const metadata = { title: "License status" };

export default function LicenseStatus() {
  return <main className="prose">
    <span className="section-label">DEVICE-BOUND ACCESS</span>
    <h1>Recover your license.</h1>
    <p>Revive licenses the physical PSG1, not the wallet or computer. Reconnect the licensed handheld and run the free web scan. A factory reset, OS reinstall, or different computer does not consume another license.</p>
    <div className="notice"><strong>No wallet sign-in is required.</strong><p>Factory resets, Android reinstalls, changing wallets, and moving to another computer do not consume another license.</p></div>
    <h2>Why the PSG1 must be connected</h2>
    <p>The website does not accept typed device serials, recovery credentials, license tokens, or manually entered transaction signatures. The web wizard derives the hashed device ID only after it cross-checks the physical PSG1 in ADB, USB, and Fastboot. A device hash alone cannot issue installer access. The deprecated desktop fallback still supports the owner-saved recovery credential; the backend stores only its digest.</p>
    <h2>If recovery fails</h2>
    <ol><li>Use a data-capable USB cable and power on the PSG1.</li><li>Accept the ADB prompt if Android displays one.</li><li>Run the read-only scan again and save the redacted support report.</li></ol>
    <p><Link className="text-link" href="/docs">Read the installation guide →</Link></p>
  </main>;
}
