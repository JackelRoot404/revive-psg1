import Link from "next/link";

export const metadata = { title: "Free PSG1 installation" };

export default function LicenseStatus() {
  return <main className="prose">
    <span className="section-label">FREE FOREVER</span>
    <h1>Free, device-bound installation.</h1>
    <p>Revive does not require a wallet, payment, promo code, or Discord approval. Connect a stock PSG1 and complete the read-only scan; the secure service decides whether its signed release is available for that exact handheld.</p>
    <div className="notice"><strong>Nothing happens until you explicitly confirm.</strong><p>A passing scan alone never unlocks, wipes, or flashes the device. Before any destructive step, the wizard explains the risks and requires you to type <b>ERASE PSG1</b>.</p></div>
    <h2>Access follows the PSG1</h2>
    <p>The entitlement is bound to the verified physical device, not a browser profile, computer, wallet, or Discord account. Reconnect the same PSG1 and complete a new scan to resume an interrupted installation.</p>
    <h2>Important limits</h2>
    <ul><li>Only stock, locked PSG1s are included in the public conversion path.</li><li>Previously unlocked or modified devices are left untouched by this release.</li><li>The conversion wipes data, leaves the bootloader unlocked, and may be irreversible.</li><li>No echOS restoration image is provided.</li></ul>
    <p><Link className="button primary inline-button" href="/wizard">Check PSG1 and continue</Link></p>
    <p><Link className="text-link" href="/docs">Read the installation guide →</Link></p>
  </main>;
}
