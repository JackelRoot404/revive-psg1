import Link from "next/link";

export const metadata = { title: "License status" };

export default function LicenseStatus() {
  return <main className="prose">
    <span className="section-label">DEVICE-BOUND ACCESS</span>
    <h1>Recover your license.</h1>
    <p>Revive licenses the physical PSG1, not the wallet or computer. Reconnect the licensed handheld to Revive Desktop, run the free scan, and enter the recovery credential shown during the initial claim. The original wallet is not required.</p>
    <div className="notice"><strong>No wallet sign-in is required.</strong><p>Factory resets, Android reinstalls, changing wallets, and moving to another computer do not consume another license.</p></div>
    <h2>Why status is checked in the desktop app</h2>
    <p>The website does not accept raw device serials, recovery credentials, license tokens, or manually entered transaction signatures. A device hash alone cannot issue a license. The credential is shown once in the paired desktop application and must be saved by the owner; Revive Desktop does not persist a local copy. The backend stores only its digest.</p>
    <h2>If recovery fails</h2>
    <ol><li>Use a data-capable USB cable and power on the PSG1.</li><li>Accept the ADB prompt if Android displays one.</li><li>Run the read-only scan again and save the redacted support report.</li></ol>
    <p><Link className="text-link" href="/docs">Read the installation guide →</Link></p>
  </main>;
}
