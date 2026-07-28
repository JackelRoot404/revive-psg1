import Link from "next/link";
import { DonationBanner } from "./donation-banner";
import { isBetaBrowserInstallerEnabled, isCompatibilityCheckerOnly, isEarlyAccessFree } from "../lib/server-config";

const capabilities = ["Physical controls", "Wi-Fi & audio", "Aurora Store", "F-Droid", "RetroArch", "Optional local GMS validation"];

export default function Home() {
  const earlyAccessFree = isEarlyAccessFree();
  const compatibilityCheckerOnly = isCompatibilityCheckerOnly();
  const betaBrowserInstaller = isBetaBrowserInstallerEnabled() && !compatibilityCheckerOnly;
  return <main>
    {earlyAccessFree && <DonationBanner />}
    <section className="hero">
      <div className="eyebrow"><span className="pulse" /> {compatibilityCheckerOnly ? "PUBLIC COMPATIBILITY CHECKER" : betaBrowserInstaller ? "DISCORD-SUPERVISED BROWSER BETA" : "SELF-SERVICE WEB INSTALLER"}</div>
      <h1>Revive your <em>PSG1.</em></h1>
      <p className="hero-copy">{compatibilityCheckerOnly
        ? "Connect your PSG1 over USB and run a free read-only scan to see whether your firmware matches a signed Revive profile. Browser unlock and flashing are not public yet."
        : betaBrowserInstaller ? "A free, Discord-supervised beta for supported PSG1s. It wipes the device, leaves the bootloader unlocked, and can be irreversible." : "Convert your unused PSG1 into a general-purpose Android gaming handheld."}</p>
      <div className="hero-actions"><Link className="button primary" href="/wizard">{compatibilityCheckerOnly ? "Check compatibility" : betaBrowserInstaller ? "Redeem beta code" : earlyAccessFree ? "Start Unlocking — Free Forever" : "Get Started"}</Link><Link className="button ghost" href="/docs">See the process</Link></div>
      <div className="trust-row"><span>✓ Free compatibility scan</span><span>✓ {compatibilityCheckerOnly ? "No device changes" : betaBrowserInstaller ? "Discord beta code required" : earlyAccessFree ? "Free forever" : "One device, one license"}</span><span>✓ {compatibilityCheckerOnly ? "Read-only USB check" : betaBrowserInstaller ? "No echOS recovery" : "Released updates included"}</span></div>
      <div className="device-card" aria-label="Revive installation preview">
        <div className="device-screen">
          <span className="screen-kicker">REVIVE / READY</span><strong>PSG1 detected</strong>
          <div className="progress"><i /></div><small>Hardware profile verified · no changes made</small>
        </div>
        <div className="device-meta"><span className="speaker">••••</span><span className="solana-key">≋</span><span className="power-led" /></div>
        <div className="controls">
          <div className="dpad" aria-hidden="true"><i className="up"/><i className="right"/><i className="down"/><i className="left"/><i className="center"/></div>
          <div className="system-buttons"><i/><i/></div>
          <div className="face-buttons" aria-hidden="true"><i className="key-x">X</i><i className="key-a">A</i><i className="key-b">B</i><i className="key-y">Y</i></div>
        </div>
      </div>
    </section>

    <section className="section split">
      <div><span className="section-label">WHAT YOU GET</span><h2>A handheld you can actually use.</h2></div>
      <div><p>Revive keeps the validated PSG1 hardware layer and installs a focused Android gaming environment. Each signed profile states exactly which hardware and software capabilities were verified.</p><div className="chips">{capabilities.map((item) => <span key={item}>{item}</span>)}</div></div>
    </section>

    <section className="section steps">
      <span className="section-label">{compatibilityCheckerOnly ? "TODAY" : "THREE CONTROLLED STAGES"}</span>
      <div className="step-grid">
        <article><b>01</b><h3>Scan</h3><p>Open desktop Chrome or Edge and connect over USB. Revive checks serial consistency, firmware, battery, storage, and recovery support—free.</p></article>
        <article><b>02</b><h3>{compatibilityCheckerOnly ? "Result" : betaBrowserInstaller ? "Beta code" : earlyAccessFree ? "Free forever" : "License"}</h3><p>{compatibilityCheckerOnly ? "See whether your PSG1 matches the signed profile. Nothing is activated, bound, unlocked, wiped, or flashed." : betaBrowserInstaller ? "Join Discord, open a support ticket, and redeem your one-time free beta code after the scan." : earlyAccessFree ? "Activate instantly—free forever. No wallet, payment, or promo code required. Access remains bound to your PSG1." : "Complete the secure checkout. The permanent entitlement binds to your PSG1, not the wallet."}</p></article>
        <article><b>03</b><h3>{compatibilityCheckerOnly ? "Coming later" : "Revive"}</h3><p>{compatibilityCheckerOnly ? "Browser unlock and flashing will open after the remaining safety cohort is complete. Follow Discord for availability." : "Follow the guided unlock and install. Every artifact is signed and verified before the device is modified."}</p></article>
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
        <p><strong>No recovery promise</strong>No echOS restoration image is provided. Beta conversion can be irreversible.</p>
      </div>
    </section>

  </main>;
}
