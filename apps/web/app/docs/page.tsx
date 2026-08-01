import Link from "next/link";

export const metadata = { title: "How it works" };

export default function Docs() {
  return <main className="prose">
    <span className="section-label">INSTALL GUIDE</span><h1>Safe by construction.</h1>
    <p>Revive is a browser-guided, deterministic process. It never asks an AI to decide what to flash. The primary wizard requires current desktop Chrome or Edge on macOS or Windows; Safari, Firefox, phones, and tablets do not expose the required WebUSB API.</p>
    <div className="notice"><strong>Availability is checked by the secure service.</strong><p>The website always runs a free read-only scan first. A passing stock PSG1 may continue only when the service has a matching signed release available; closing the service never changes a compatibility result.</p></div>
    <h2>Before anything changes</h2>
    <ol><li>Connect the powered-on PSG1 with a data-capable USB cable.</li><li>Authorize ADB when the PSG1 asks.</li><li>Run the free scan. Serial, firmware, partitions, battery, host storage, and recovery support must all pass a signed profile.</li></ol>
    <p>An unknown build receives a redacted read-only compatibility report. It is never charged, bound, unlocked, or flashed.</p>
    <h2 id="windows-fastboot">Windows Fastboot setup</h2>
    <p>Windows uses a separate USB driver after the PSG1 changes from Android to Fastboot. The production path will provide a signed PSG1-specific WinUSB package for this interface. Until that package is published, the wizard links to the temporary support procedure below when Windows cannot open Fastboot.</p>
    <ol><li>Leave the PSG1 connected in Fastboot and keep the Revive wizard open.</li><li>Download <a className="text-link" href="https://zadig.akeo.ie/" target="_blank" rel="noreferrer">Zadig from its official site ↗</a>. Its digital signature should name <em>Akeo Consulting</em>.</li><li>In Zadig, choose <strong>Options → List All Devices</strong>, then select <strong>USB Download Gadget</strong>—the PSG1 Fastboot device.</li><li>Select <strong>WinUSB</strong>, choose <strong>Install Driver</strong>, then return to Revive and retry the Fastboot selection.</li></ol>
    <p><strong>Important:</strong> Select <strong>USB Download Gadget</strong> only. Do not replace <strong>Android ADB Interface</strong> or any unrelated USB device. This changes only the Windows driver binding; it does not unlock, wipe, flash, or otherwise modify the PSG1.</p>
    <h2>Free access</h2>
    <p>A passing stock PSG1 can activate free device-bound installation access. There is no wallet, payment, transaction, or promo code requirement.</p>
    <h2>Unlock and installation</h2>
    <p>The app explains the wipe and verified-boot implications, requires an exact confirmation phrase, and journals every step. Downloads resume after interruption and are signature- and hash-checked before use.</p>
    <h2>What is tested</h2>
    <p>The release profile requires two cold boots plus controls, Wi-Fi, audio, storage, application installation, and recovery checks. A capability is advertised only when the matching signed profile records a pass.</p>
    <h2>Optional Google services</h2>
    <p>Revive does not distribute, proxy, or host Google Mobile Services or Play Store unless it first obtains a Google license. Google states that GMS is not part of AOSP and is available only through a license with Google. If a future release permits a customer-supplied package, the owner must obtain the release-approved artifact from its original publisher and select it locally; Revive will verify the approved hash and will never upload or proxy it. See <a className="text-link" href="https://www.android.com/gms/" target="_blank" rel="noreferrer">Google&apos;s official GMS licensing overview ↗</a>.</p>
    <h2>Important limitations</h2>
    <ul><li>The bootloader remains unlocked after conversion.</li><li>The device and replacement ROM are not Google-certified. Play Integrity, banking, DRM, and some games may refuse to run.</li><li>Fingerprint is unvalidated and not guaranteed; it is not a launch feature.</li><li>No echOS restoration image or recovery credential is provided; conversion can be irreversible.</li><li>No Android ROM can guarantee that every application will work.</li></ul>
    <h2>Resume after interruption</h2>
    <p>Reconnect the same physical PSG1 and run the scan again. Its device-bound installation entitlement and verified local journal resume the eligible signed stage without another approval step.</p>
    <p><Link className="button primary inline-button" href="/wizard">Check PSG1 and continue</Link></p>
  </main>;
}
