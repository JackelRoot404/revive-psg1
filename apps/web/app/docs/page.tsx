import Link from "next/link";
import { isBetaBrowserInstallerEnabled, isCompatibilityCheckerOnly } from "../../lib/server-config";

export const metadata = { title: "How it works" };

export default function Docs() {
  const beta = isBetaBrowserInstallerEnabled();
  const compatibilityCheckerOnly = isCompatibilityCheckerOnly();
  return <main className="prose">
    <span className="section-label">INSTALL GUIDE</span><h1>Safe by construction.</h1>
    <p>Revive is a browser-guided, deterministic process. It never asks an AI to decide what to flash. The primary wizard requires current desktop Chrome or Edge on macOS or Windows; Safari, Firefox, phones, and tablets do not expose the required WebUSB API.</p>
    {compatibilityCheckerOnly && <div className="notice"><strong>Public compatibility checker only.</strong><p>The live website runs the free read-only scan today. Browser unlock, activation, and flashing remain closed until the remaining safety cohort is complete.</p></div>}
    <h2>Before anything changes</h2>
    <ol><li>Connect the powered-on PSG1 with a data-capable USB cable.</li><li>Authorize ADB when the PSG1 asks.</li><li>Run the free scan. Serial, firmware, partitions, battery, host storage, and recovery support must all pass a signed profile.</li></ol>
    <p>An unknown build receives a redacted read-only compatibility report. It is never charged, bound, unlocked, or flashed.</p>
    {!compatibilityCheckerOnly && <>
      <h2>{beta ? "Discord beta access" : "Free access"}</h2>
      <p>{beta ? "After a supported scan, enter a one-time Discord code. It binds to the first compatible PSG1 that redeems it. There is no wallet, payment, refund, transaction, or recovery-credential flow." : "Access is free and device-bound. No wallet, payment, transaction, or promo code is required."}</p>
      <h2>Unlock and installation</h2>
      <p>The app explains the wipe and verified-boot implications, requires an exact confirmation phrase, and journals every step. Downloads resume after interruption and are signature- and hash-checked before use.</p>
    </>}
    <h2>What is tested</h2>
    <p>The release profile requires two cold boots plus controls, Wi-Fi, audio, storage, application installation, and recovery checks. A capability is advertised only when the matching signed profile records a pass.</p>
    <h2>Optional Google services</h2>
    <p>Revive does not distribute, proxy, or host Google Mobile Services or Play Store unless it first obtains a Google license. Google states that GMS is not part of AOSP and is available only through a license with Google. If a future release permits a customer-supplied package, the owner must obtain the release-approved artifact from its original publisher and select it locally; Revive will verify the approved hash and will never upload or proxy it. See <a className="text-link" href="https://www.android.com/gms/" target="_blank" rel="noreferrer">Google&apos;s official GMS licensing overview ↗</a>.</p>
    <h2>Important limitations</h2>
    <ul><li>The bootloader remains unlocked after conversion.</li><li>The device and replacement ROM are not Google-certified. Play Integrity, banking, DRM, and some games may refuse to run.</li><li>Fingerprint is unvalidated and not guaranteed; it is not a launch feature.</li><li>No echOS restoration image or recovery credential is provided; conversion can be irreversible.</li><li>No Android ROM can guarantee that every application will work.</li></ul>
    <h2>Resume after interruption</h2>
    <p>Reconnect the same physical PSG1 and run the scan again. Its device-bound beta entitlement and the browser&apos;s verified local installation journal resume the eligible signed stage without consuming another Discord code.</p>
    {compatibilityCheckerOnly && <p><Link className="button primary inline-button" href="/wizard">Run the compatibility check</Link></p>}
  </main>;
}
