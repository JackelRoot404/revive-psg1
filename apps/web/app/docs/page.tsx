import { isEarlyAccessFree } from "../../lib/server-config";

export const metadata = { title: "How it works" };

export default function Docs() {
  const earlyAccessFree = isEarlyAccessFree();
  return <main className="prose">
    <span className="section-label">INSTALL GUIDE</span><h1>Safe by construction.</h1>
    <p>Revive is a browser-guided, deterministic process. It never asks an AI to decide what to flash. The primary wizard requires current desktop Chrome or Edge on macOS or Windows; Safari, Firefox, phones, and tablets do not expose the required WebUSB API.</p>
    <h2>Before anything changes</h2>
    <ol><li>Connect the powered-on PSG1 with a data-capable USB cable.</li><li>Authorize ADB when the PSG1 asks.</li><li>Run the free scan. Serial, firmware, partitions, battery, host storage, and recovery support must all pass a signed profile.</li></ol>
    <p>An unknown build receives a redacted read-only compatibility report. It is never charged, bound, unlocked, or flashed.</p>
    <h2>{earlyAccessFree ? "Free Early Access" : "License and checkout"}</h2>
    <p>{earlyAccessFree ? "After the scan matches a signed compatibility profile, Revive activates free device-bound Early Access and issues short-lived installer authorization. No wallet, payment, transaction, or promo code is required. Donations are optional and never affect access." : "After the free scan matches a signed compatibility profile, a compatible Solana wallet authorizes checkout. After finalized payment, the receipt wallet unlocks short-lived web-installer access. The permanent entitlement binds to the cross-checked PSG1 identifier—not the wallet or computer."}</p>
    <h2>Unlock and installation</h2>
    <p>The app explains the wipe and verified-boot implications, requires an exact confirmation phrase, and journals every step. Downloads resume after interruption and are signature- and hash-checked before use.{earlyAccessFree ? "" : " Normal refund eligibility ends immediately before the first destructive unlock/flash command."}</p>
    <h2>What is tested</h2>
    <p>The release profile requires two cold boots plus controls, Wi-Fi, audio, storage, application installation, and recovery checks. A capability is advertised only when the matching signed profile records a pass.</p>
    <h2>Optional Google services</h2>
    <p>Revive does not distribute, proxy, or host Google Mobile Services or Play Store unless it first obtains a Google license. Google states that GMS is not part of AOSP and is available only through a license with Google. If a future release permits a customer-supplied package, the owner must obtain the release-approved artifact from its original publisher and select it locally; Revive will verify the approved hash and will never upload or proxy it. See <a className="text-link" href="https://www.android.com/gms/" target="_blank" rel="noreferrer">Google&apos;s official GMS licensing overview ↗</a>.</p>
    <h2>Important limitations</h2>
    <ul><li>The bootloader remains unlocked after conversion.</li><li>The device and replacement ROM are not Google-certified. Play Integrity, banking, DRM, and some games may refuse to run.</li><li>Fingerprint is unvalidated and not guaranteed; it is not a launch feature.</li><li>Restoration depends on a verified official echOS image for the exact device variant.</li><li>No Android ROM can guarantee that every application will work.</li></ul>
    <h2>Recovery and reinstall</h2>
    <p>Reconnect the physical PSG1 and run the scan to recover an existing entitlement. A factory reset, OS reinstall, or different computer does not consume a second device activation.{earlyAccessFree ? " No original wallet is needed." : " Device-bound recovery credentials remain the long-term fallback if the receipt wallet is later unavailable."}</p>
  </main>;
}
