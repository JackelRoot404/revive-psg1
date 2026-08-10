import Link from "next/link";

const capabilities = ["WebUSB prototype", "Signed policy schemas", "Installation journal", "Resume design", "Diagnostics source", "Automated fixtures"];

export default function Home() {
  return <main>
    <section className="hero">
      <div className="eyebrow"><span className="pulse" /> COMMUNITY RESEARCH HANDOFF</div>
      <h1>Continue <em>Revive PSG1.</em></h1>
      <p className="hero-copy">Active development and hosted operation have ended. This unfinished Apache-2.0 project is available for community research, but it has no stock-device validation or approved flashing release.</p>
      <div className="hero-actions"><Link className="button primary" href="https://github.com/biccsdev/revive-psg1">View the source</Link><Link className="button ghost" href="/docs">Read the safety model</Link></div>
      <div className="trust-row"><span>✓ Scan-only default</span><span>✓ No release binaries</span><span>✓ Community contributions welcome</span></div>
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
      <div><span className="section-label">WHAT EXISTS</span><h2>A safety-first prototype.</h2></div>
      <div><p>The repository preserves the compatibility scanner, guarded installer architecture, research notes, and unresolved release gates. It does not include firmware or a supported conversion.</p><div className="chips">{capabilities.map((item) => <span key={item}>{item}</span>)}</div></div>
    </section>

    <section className="section steps">
      <span className="section-label">THREE CONTROLLED STAGES</span>
      <div className="step-grid">
        <article><b>01</b><h3>Scan</h3><p>Open desktop Chrome or Edge and connect over USB. Revive checks serial consistency, firmware, battery, storage, and recovery support—free.</p></article>
        <article><b>02</b><h3>Decision</h3><p>See a clear result: ready, temporarily blocked with a fix, or not part of the stock-device release. No device is modified during the scan.</p></article>
        <article><b>03</b><h3>Research</h3><p>Complete the stock-hardware, attestation, driver, artifact, recovery, and independent-security gates before proposing any flashing release.</p></article>
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
        <p><strong>No recovery promise</strong>No echOS restoration image is provided. Conversion can be irreversible.</p>
      </div>
    </section>

  </main>;
}
