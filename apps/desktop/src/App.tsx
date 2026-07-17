import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import { onOpenUrl } from "@tauri-apps/plugin-deep-link";
import type { Journal, ScanResult } from "./types";

type View = "connect" | "scanning" | "result" | "unsupported" | "license" | "recovery" | "ready" | "install" | "done";

export function App() {
  const [view, setView] = useState<View>("connect");
  const [scan, setScan] = useState<ScanResult>();
  const [journal, setJournal] = useState<Journal>();
  const [error, setError] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [sessionId, setSessionId] = useState("");
  const [reportId, setReportId] = useState("");
  const [recoveryCredential, setRecoveryCredential] = useState("");
  const [issuedRecoveryCredential, setIssuedRecoveryCredential] = useState("");

  useEffect(() => {
    invoke<Journal | null>("load_journal").then((value) => value && setJournal(value)).catch(() => {});
    const dispose = onOpenUrl(async (urls) => {
      const first = urls[0]; if (!first) return;
      const url = new URL(first);
      if (url.protocol === "revive-psg1:" && url.hostname === "browser-proof") {
        try { await invoke("complete_browser_proof", { deepLink: first }); }
        catch (cause) { setError(String(cause)); }
        return;
      }
      const orderId = url.searchParams.get("order");
      if (!orderId || !sessionId) return;
      try { const recovery = await invoke<string>("claim_license", { orderId, sessionId }); setIssuedRecoveryCredential(recovery); setView("ready"); }
      catch (cause) { setError(String(cause)); }
    });
    return () => { void dispose.then((unlisten) => unlisten()); };
  }, [sessionId]);

  async function runScan() {
    setView("scanning"); setError("");
    try {
      const result = await invoke<ScanResult>("scan_device");
      setScan(result);
      const match = await invoke<boolean>("match_embedded_profile", { scan: result });
      setView(match ? "result" : "unsupported");
    } catch (cause) { setError(String(cause)); setView("connect"); }
  }

  async function checkout() {
    if (!scan) return;
    try {
      const start = await invoke<{sessionId:string;checkoutUrl:string|null;restored:boolean;recoveryRequired:boolean}>("create_checkout_session", { scan });
      setSessionId(start.sessionId);
      if (start.restored) { setView("ready"); return; }
      if (start.recoveryRequired) { setView("recovery"); return; }
      if (!start.checkoutUrl) throw new Error("Checkout URL was not issued");
      await openUrl(start.checkoutUrl); setView("license");
    } catch (cause) { setError(String(cause)); }
  }

  async function recover() {
    try { await invoke("recover_license", { recoveryCredential }); setRecoveryCredential(""); setView("ready"); }
    catch (cause) { setError(String(cause)); }
  }

  return <div className="app">
    <aside><div className="logo">R</div><strong>REVIVE<br/>PSG1</strong><div className="rail" />{["Connect","Scan","License","Unlock","Install","Verify"].map((item, index) => <span className={stepActive(view,index) ? "active" : ""} key={item}><i>{index+1}</i>{item}</span>)}</aside>
    <main>
      <header><span>DESKTOP INSTALLER</span><small>v0.1.0-beta · signed profiles only</small></header>
      {view === "connect" && <Panel label="DEVICE CONNECTION" title="Connect your PSG1." copy="Power it on, use a data-capable USB cable, and approve the ADB prompt on the handheld."><Checklist items={["PSG1 powered on","Battery above 50%","USB data cable","Screen unlocked"]}/><button onClick={runScan}>Scan connected device →</button></Panel>}
      {view === "scanning" && <Panel label="READ-ONLY SCAN" title="Checking compatibility…" copy="Reading device identity, firmware, power, USB, and recovery capabilities. No partitions are being changed."><div className="scanner"><i/><span>ADB → USB serial → Fastboot serial</span></div></Panel>}
      {view === "result" && scan && <Panel label="SUPPORTED DEVICE" title="This PSG1 is ready." copy="The scan matches a signed compatibility profile. Your serial was consistent across Android, USB, and Fastboot."><dl><Row k="Hardware" v={scan.board}/><Row k="Firmware" v={scan.build_incremental}/><Row k="Battery" v={`${scan.battery_percent}%`}/><Row k="Device ID" v={`${scan.device_id.slice(0,12)}…`}/></dl><button onClick={checkout}>Continue to license · 29 USDC →</button></Panel>}
      {view === "unsupported" && <Panel label="UNKNOWN FIRMWARE" title="Not safe to install yet." copy="Revive will not charge or modify this device. Submit a redacted report so this build can be validated and added to a signed profile.">{reportId ? <div className="warning">Report received: {reportId}</div> : <button onClick={() => {setError("");invoke<string>("submit_compatibility_report", { scan }).then(setReportId).catch((cause)=>setError(String(cause)))}}>Submit compatibility report</button>}<button className="secondary" onClick={() => setView("connect")}>Back</button></Panel>}
      {view === "license" && <Panel label="BROWSER CHECKOUT" title="Finish in your wallet." copy="Keep this app open while the checkout page verifies this computer. The installer advances only after the API returns a signed device license."><div className="scanner"><i/><span>Waiting for verified browser checkout…</span></div><button className="secondary" onClick={checkout}>Reopen checkout</button></Panel>}
      {view === "recovery" && <Panel label="LICENSE RECOVERY" title="This PSG1 is already licensed." copy="Enter the recovery credential saved during the first installation. The original wallet is not required."><label>Recovery credential<input value={recoveryCredential} onChange={(e)=>setRecoveryCredential(e.target.value)} placeholder="rpr_…" autoComplete="off" spellCheck={false}/></label><button disabled={!recoveryCredential.trim()} onClick={recover}>Recover device license</button></Panel>}
      {view === "ready" && <Panel label="WIPE & SECURITY" title="One last deliberate check." copy="Unlocking erases all PSG1 data and changes verified-boot security. Keep the cable connected and do not power off.">{issuedRecoveryCredential && <div className="warning"><b>Save this recovery credential now.</b><br/><code>{issuedRecoveryCredential}</code><br/>It is shown once and restores this PSG1 on another computer without the purchasing wallet. Revive does not save a local copy.</div>}<div className="warning">Normal refund eligibility ends immediately before the first unlock command runs.</div><label>Type <b>ERASE PSG1</b> to continue<input value={confirmation} onChange={(e)=>setConfirmation(e.target.value)}/></label><button disabled={confirmation !== "ERASE PSG1"} onClick={() => setView("install")}>Verify license and prepare unlock</button></Panel>}
      {view === "install" && <Panel label="DETERMINISTIC INSTALL" title="Installer controls remain locked." copy="A production-signed release manifest, profile, and device license must be retrieved before this screen can execute the journaled unlock and flash state machine."><button onClick={() => invoke("begin_installation", { confirmation }).then((j)=>{setJournal(j as Journal);setView("done")}).catch((e)=>setError(String(e)))}>Begin verified installation</button></Panel>}
      {view === "done" && <Panel label="VERIFICATION" title="Your PSG1 is revived." copy="Two cold boots and the hardware/app checks completed. Keep the local recovery report in a safe place."><button onClick={()=>invoke("open_recovery_report")}>Open recovery report</button></Panel>}
      {journal && <div className="resume">Journal: <b>{journal.stage}</b> · {journal.events.length} recorded events{journal.stage === "recovery_required" ? " · Reconnect the same PSG1 and retry to resume safely." : ""}</div>}
      {error && <div className="error">{error}</div>}
    </main>
  </div>;
}

function Panel({label,title,copy,children}:{label:string;title:string;copy:string;children?:React.ReactNode}){return <section><span className="label">{label}</span><h1>{title}</h1><p>{copy}</p>{children}</section>}
function Checklist({items}:{items:string[]}){return <div className="checklist">{items.map(item=><span key={item}>✓ {item}</span>)}</div>}
function Row({k,v}:{k:string;v:string}){return <><dt>{k}</dt><dd>{v}</dd></>}
function stepActive(view:View,index:number){const map:Record<View,number>={connect:0,scanning:1,result:1,unsupported:1,license:2,recovery:2,ready:3,install:4,done:5};return map[view]>=index}
