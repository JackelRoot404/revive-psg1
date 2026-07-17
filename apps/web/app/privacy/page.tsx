import { legalConfig, legalConfigComplete } from "../../lib/public-config";
import { isEarlyAccessFree } from "../../lib/server-config";

export const metadata = { title: "Privacy" };

export default function Privacy() {
  const earlyAccessFree = isEarlyAccessFree();
  return <main className="prose">
    <span className="section-label">{legalConfigComplete ? "PRIVACY NOTICE" : "PRE-LAUNCH DRAFT"}</span>
    <h1>Privacy</h1>
    {!legalConfigComplete && <div className="legal-draft" role="alert"><strong>Retention and effective-date details are incomplete.</strong><p>This draft describes the intended data flow but is not a substitute for a counsel-reviewed production notice.</p></div>}
    <p><strong>Controller/provider:</strong> {legalConfig.entity}<br/><strong>Effective date:</strong> {legalConfig.effectiveDate ?? "[EFFECTIVE DATE REQUIRED]"}<br/><strong>Privacy/support contact:</strong> <a href={legalConfig.supportUrl}>Discord support server</a></p>
    <h2>Data used by Revive</h2>
    <ul><li>A one-way, domain-separated hash of the cross-checked PSG1 bootloader serial. The raw serial remains on the local computer.</li>{!earlyAccessFree && <li>The paying public wallet, order reference, and finalized transaction signature for receipts, reconciliation, replay prevention, and fraud investigation.</li>}<li>Compatibility profile fields needed to decide support. Unknown-build and crash reports are redacted and submitted only through the stated product flow.</li><li>Security audit events, coarse request metadata, and rate-limit state needed to operate and protect the service.</li></ul>
    <h2>Data not used as the license key</h2>
    <p>Revive does not bind the license to an Android installation ID, wallet, hostname, computer ID, or Google account. It does not ask users to paste raw device serials or license tokens into this website.</p>
    <h2>Processors and public-chain data</h2>
    <p>Hosting providers process service data on our behalf. Optional Solana donations are public blockchain records outside Revive&apos;s control and are not linked to installer access by the product. A final notice must name production processors, regions, transfer safeguards, and user-rights procedures.</p>
    <h2>Retention</h2>
    <p>{legalConfig.retention ?? "[RETENTION PERIODS FOR ORDERS, LICENSES, REPORTS, LOGS, AUDIT EVENTS, AND REFUNDS REQUIRED]"}</p>
    <h2>Your choices</h2>
    <p>Optional crash reporting can be disabled. The production notice must explain applicable access, correction, deletion, objection, and complaint rights, including information that cannot be deleted because it is required for security, accounting, or permanent device-license recovery.</p>
  </main>;
}
