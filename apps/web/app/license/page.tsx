import Link from "next/link";

export const metadata = { title: "Revive PSG1 license" };

export default function LicenseStatus() {
  return <main className="prose">
    <span className="section-label">OPEN SOURCE</span>
    <h1>Apache-2.0 community project.</h1>
    <p>The original Revive source is available under the Apache License 2.0. Third-party dependencies, trademarks, and upstream Android or LineageOS source remain under their respective terms.</p>
    <div className="notice"><strong>No supported flashing release exists.</strong><p>The hosted service has ended, no stock PSG1 completed the flow, and no firmware, APK, Windows driver, or signing key is distributed with this source.</p></div>
    <h2>Community continuation</h2>
    <p>Contributors must preserve the scan-only default and complete the documented hardware, attestation, release, driver, recovery, and security gates before enabling destructive work.</p>
    <h2>Important limits</h2>
    <ul><li>The code and research are provided as-is without warranty.</li><li>The project is unofficial and unaffiliated with PlaySolana, Google, or LineageOS.</li><li>Conversion can wipe data, leave the bootloader unlocked, and be irreversible.</li><li>No echOS restoration image is provided.</li></ul>
    <p><Link className="button primary inline-button" href="https://github.com/biccsdev/revive-psg1">View the source</Link></p>
    <p><Link className="text-link" href="/docs">Read the safety model →</Link></p>
  </main>;
}
