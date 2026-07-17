import { legalConfig, legalConfigComplete } from "../../lib/public-config";
import { isEarlyAccessFree } from "../../lib/server-config";

export const metadata = { title: "Terms" };

export default function Terms() {
  const earlyAccessFree = isEarlyAccessFree();
  return <main className="prose">
    <span className="section-label">{legalConfigComplete ? "TERMS OF SERVICE" : "PRE-LAUNCH DRAFT"}</span>
    <h1>Terms</h1>
    {!legalConfigComplete && <div className="legal-draft" role="alert"><strong>Not ready for public acceptance.</strong><p>Effective date, governing law, retention terms, and counsel review must be completed before a stable public release.</p></div>}
    <p><strong>Provider:</strong> {legalConfig.entity}<br/><strong>Effective date:</strong> {legalConfig.effectiveDate ?? "[EFFECTIVE DATE REQUIRED]"}<br/><strong>Support:</strong> <a href={legalConfig.supportUrl}>Discord support server</a></p>
    <h2>{earlyAccessFree ? "Early Access" : "License"}</h2>
    <p>{earlyAccessFree ? "Revive is currently provided at no cost during Early Access. Donations are optional, do not purchase additional rights, and do not affect compatibility or access. Paid licensing may return after a stable v1.0 release." : "A purchase licenses one compatible PSG1 device and includes updates released for that licensed device. The paying wallet receives the receipt but is not the device identifier."} A factory reset, supported OS reinstall, wallet change, or move to another computer does not consume another device activation.</p>
    {!earlyAccessFree && <><h2>Refund boundary</h2><p>A paid license is normally refundable until Revive records the start of the first destructive unlock or flash operation. A refunded entitlement is revoked. Verified incompatibility may remain eligible for review afterward. Beta licenses have no monetary or refundable value.</p></>}
    <h2>Device changes and limitations</h2>
    <p>Unlocking wipes the PSG1 and leaves its bootloader unlocked, changing its security posture. The replacement ROM and device are not Google-certified. Play Integrity, banking, DRM, and some games may not work. Revive does not distribute Google Mobile Services or Play Store without a Google license. Fingerprint support is not currently promised. Restoration depends on a verified official echOS image for the matching hardware variant.</p>
    <h2>Compatibility</h2>
    <p>The free scan must match a signed compatibility profile before access or modification. Revive does not promise universal Android application compatibility and must reject unknown firmware without activating or flashing it.</p>
    <h2>Required final clauses</h2>
    <p>Warranty disclaimer, limitation of liability, intellectual-property notices, dispute process, tax treatment, age requirements, termination, and the complete refund/support procedure require counsel-approved language before launch.</p>
    <p><strong>Governing law:</strong> {legalConfig.governingLaw ?? "[JURISDICTION AND GOVERNING LAW REQUIRED]"}</p>
  </main>;
}
