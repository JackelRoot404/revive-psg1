import { legalConfig, legalConfigComplete } from "../../lib/public-config";
import { isBetaBrowserInstallerEnabled } from "../../lib/server-config";

export const metadata = { title: "Terms" };

export default function Terms() {
  const beta = isBetaBrowserInstallerEnabled();
  return <main className="prose">
    <span className="section-label">{legalConfigComplete ? "TERMS OF SERVICE" : "PRE-LAUNCH DRAFT"}</span>
    <h1>Terms</h1>
    {!legalConfigComplete && <div className="legal-draft" role="alert"><strong>Not ready for public acceptance.</strong><p>Effective date, governing law, retention terms, and counsel review must be completed before a stable public release.</p></div>}
    <p><strong>Provider:</strong> {legalConfig.entity}<br/><strong>Effective date:</strong> {legalConfig.effectiveDate ?? "[EFFECTIVE DATE REQUIRED]"}<br/><strong>Support:</strong> <a href={legalConfig.supportUrl}>Discord support server</a></p>
    <h2>{beta ? "Free Discord beta" : "Free access"}</h2>
    <p>{beta ? "The beta is free, invitation-only, and supervised through Discord. A one-time code binds to its first compatible PSG1." : "Revive access is free."} Donations are optional and do not purchase rights or affect compatibility or access. There is no wallet, payment, refund, or recovery-credential flow.</p>
    <h2>Device changes and limitations</h2>
    <p>Unlocking wipes the PSG1 and leaves its bootloader unlocked, changing its security posture. The replacement ROM and device are not Google-certified. Play Integrity, banking, DRM, and some games may not work. Revive does not distribute Google Mobile Services or Play Store. Fingerprint support is not currently promised. No echOS restoration image is provided: beta conversion may be irreversible and can leave the device unusable.</p>
    <h2>Compatibility</h2>
    <p>The free scan must match a signed compatibility profile before access or modification. Revive does not promise universal Android application compatibility and must reject unknown firmware without activating or flashing it.</p>
    <h2>Required final clauses</h2>
    <p>Warranty disclaimer, limitation of liability, intellectual-property notices, dispute process, tax treatment, age requirements, termination, and the complete refund/support procedure require counsel-approved language before launch.</p>
    <p><strong>Governing law:</strong> {legalConfig.governingLaw ?? "[JURISDICTION AND GOVERNING LAW REQUIRED]"}</p>
  </main>;
}
