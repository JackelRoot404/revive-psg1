import Link from "next/link";
import { publicSalesState, releaseDownloads } from "../lib/public-config";

const capabilities = ["Physical controls", "Wi-Fi & audio", "Aurora Store", "F-Droid", "RetroArch", "Optional local GMS validation"];

export default function Home() {
  const downloadsOpen = publicSalesState !== "closed";
  return <main>
    <section className="hero">
      <div className="eyebrow"><span className="pulse" /> SELF-SERVICE WEB INSTALLER</div>
      <h1>Revive your <em>PSG1.</em></h1>
      <p className="hero-copy">Convert your unused PSG1 into a general-purpose Android gaming handheld—with working physical controls and a careful, recoverable install flow.</p>
      <div className="hero-actions"><Link className="button primary" href="/wizard">Start web wizard</Link><Link className="button ghost" href="/docs">See the process</Link></div>
      <div className="trust-row"><span>✓ Free compatibility scan</span><span>✓ One device, one license</span><span>✓ Released updates included</span></div>
      <div className="device-card" aria-label="Revive installation preview">
        <div className="device-screen">
          <span className="screen-kicker">REVIVE / READY</span><strong>PSG1 detected</strong>
          <div className="progress"><i /></div><small>Hardware profile verified · no changes made</small>
        </div>
        <div className="controls"><div className="dpad">✦</div><div className="buttons">A&nbsp;&nbsp; B<br/>X&nbsp;&nbsp; Y</div></div>
      </div>
    </section>

    <section className="section split">
      <div><span className="section-label">WHAT YOU GET</span><h2>A handheld you can actually use.</h2></div>
      <div><p>Revive keeps the validated PSG1 hardware layer and installs a focused Android gaming environment. Each signed profile states exactly which hardware and software capabilities were verified.</p><div className="chips">{capabilities.map((item) => <span key={item}>{item}</span>)}</div></div>
    </section>

    <section className="section steps">
      <span className="section-label">THREE CONTROLLED STAGES</span>
      <div className="step-grid">
        <article><b>01</b><h3>Scan</h3><p>Open desktop Chrome or Edge and connect over USB. Revive checks serial consistency, firmware, battery, storage, and recovery support—free.</p></article>
        <article><b>02</b><h3>License</h3><p>Pay 29 USDC from a paired wallet extension. The permanent entitlement binds to your PSG1, not the wallet.</p></article>
        <article><b>03</b><h3>Revive</h3><p>Follow the guided unlock and install. Every artifact is signed and verified before the device is modified.</p></article>
      </div>
    </section>

    <section className="section limitations">
      <span className="section-label">IMPORTANT LIMITATIONS</span>
      <h2>Know what changes.</h2>
      <div className="limitation-grid">
        <p><strong>Unlocked bootloader</strong>The PSG1 remains bootloader-unlocked after conversion, changing its security posture.</p>
        <p><strong>Not Google-certified</strong>The device and ROM are not Google-certified. Play Integrity, banking, DRM, and some games may refuse to run.</p>
        <p><strong>GMS not distributed</strong>Revive does not host or distribute Google Mobile Services or Play Store without a Google license.</p>
        <p><strong>Fingerprint not promised</strong>Fingerprint support is currently unvalidated and not guaranteed for the launch profile.</p>
        <p><strong>Restoration dependency</strong>Restoring echOS requires a verified official customer-supplied image for the matching PSG1 variant.</p>
      </div>
    </section>

    <section id="download" className="section download-panel">
      <div><span className="section-label">DEPRECATED DESKTOP FALLBACK</span><h2>Native recovery tools remain available.</h2><p>The web wizard is the primary experience. Signed macOS and Windows apps are retained as a deprecated fallback for unsupported browsers, Windows USB-driver limitations, and recovery.</p></div>
      <div className="download-actions">
        <DownloadLink platform="macOS" href={downloadsOpen ? releaseDownloads.macos : null} />
        <DownloadLink platform="Windows" href={downloadsOpen ? releaseDownloads.windows : null} secondary />
        <small>{downloadsOpen ? "Use only signed builds from revivepsg.com." : "Fallback downloads remain disabled until signed packages and official URLs are configured."} Never use an unofficial mirror.</small>
      </div>
    </section>
  </main>;
}

function DownloadLink({ platform, href, secondary = false }: { platform: string; href: string | null; secondary?: boolean }) {
  if (!href) return <button className={`button ${secondary ? "ghost" : "primary"}`} disabled>{platform} · signed build unavailable</button>;
  return <a className={`button ${secondary ? "ghost" : "primary"}`} href={href} rel="nofollow">Download for {platform}</a>;
}
