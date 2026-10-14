"use client";
import { EmergencyPaymentPanel } from "@/components/emergency-payment";
import { useEffect, useRef, useState } from "react";
import { signMessage, getNetworkDetails } from "@stellar/freighter-api";
import { connectWallet, refreshWallet } from "@/lib/wallet";
import { browserRequest } from "@/lib/browser-api";
import { createRequest, decisionMessage, readRequests, EMERGENCY_NAMES, EMERGENCY_RECIPIENTS, type EmergencyRequest, type EmergencyRecipient, type EmergencyIntegration } from "@/lib/emergency";

const KEY = "padala-pabalik-emergency-v3";
export function EmergencyPot({ phpRate }: { phpRate: number | null }) {
  const [requests, setRequests] = useState<EmergencyRequest[]>([]);
  const [recipient, setRecipient] = useState<EmergencyRecipient>("parents");
  const [reviewing, setReviewing] = useState(false);
  const reviewLock = useRef(false);
  const [amount, setAmount] = useState("50");
  const [reason, setReason] = useState("");
  const [ready, setReady] = useState(false);
  const [blocked, setBlocked] = useState(false);
  const [message, setMessage] = useState("");
  const [integrations, setIntegrations] = useState<EmergencyIntegration[]>([]);

  const [confirmation, setConfirmation] = useState<string | null>(null);
  useEffect(() => {
    let hasSaved = false;
    try {
      const raw = localStorage.getItem(KEY);
      if (raw) {
        hasSaved = true;
        const records = readRequests(raw);
        const previous: EmergencyRequest[] = JSON.parse(raw);
        if (previous.some(record => !record.decision && (record.status !== "pending" || record.approvals.length))) setMessage("Previous simulated decisions were reset. These requests now need one active-wallet signature.");
        setRequests(records.map(record => ({ ...record, approvals: [], status: "pending", decision: undefined })));
        setReady(false);
        void Promise.all(records.map(record => record.decision ? browserRequest<EmergencyRequest>("/api/emergency/approval", { request: record, verify: true }) : Promise.resolve(record))).then(setRequests).catch(() => { setBlocked(true); setMessage("Saved wallet approvals could not be verified. Updates blocked; preserve history and try reloading."); }).finally(() => setReady(true));
      }
      else if (localStorage.getItem("padala-pabalik-emergency-v2")) setMessage("Previous demo requests remain in v2 storage. They lack requester and distinct approval evidence; recreate them here for review.");
    } catch { setBlocked(true); setMessage("Emergency history could not be read. New changes are blocked to preserve existing records."); }
    if (!hasSaved) setReady(true);
    let cancelled = false;
    browserRequest<EmergencyIntegration[]>("/api/emergency/integration").then(data => { if (!cancelled) setIntegrations(data); }).catch(() => { if (!cancelled) setMessage("Emergency configuration unavailable. Refresh to retry live payment verification."); });
    return () => { cancelled = true; };
  }, []);
  async function review(request: EmergencyRequest, approve: boolean) {
    if (reviewLock.current || blocked || !ready) return;
    reviewLock.current = true; setReviewing(true); setMessage("");
    try {
      if (!navigator.locks) throw new Error("Use a browser with Web Locks for wallet approvals.");
      await navigator.locks.request(KEY, async () => {
        const current = readRequests(localStorage.getItem(KEY) ?? "[]");
        const record = current.find(item => item.id === request.id);
        if (!record || record.status !== "pending") throw new Error("This request has already been reviewed or is unavailable.");
        const address = await connectWallet();
        const network = await getNetworkDetails();
        if (network.error || network.networkPassphrase !== "Test SDF Network ; September 2015") throw new Error("Switch Freighter to Testnet to review requests.");
        const signed = await signMessage(decisionMessage(record, approve, window.location.origin), { address, networkPassphrase: network.networkPassphrase });
        if (signed.error) throw new Error(signed.error.message);
        if (!signed.signedMessage || signed.signerAddress !== address || await refreshWallet() !== address) throw new Error("Active wallet changed or did not provide its signature.");
        const signature = typeof signed.signedMessage === "string" ? signed.signedMessage : signed.signedMessage.toString("base64");
        const decided = await browserRequest<EmergencyRequest>("/api/emergency/approval", { request: record, signerAddress: address, signature, approve });
        localStorage.setItem(KEY, JSON.stringify(current.map(item => item.id === record.id ? decided : item)));
        setRequests(current.map(item => item.id === record.id ? decided : item));
        setMessage(approve ? "Approved by the active wallet. No payment sent." : "Rejected by the active wallet. No payment sent.");
      });
    } catch (error) { setMessage(error instanceof Error ? error.message : "Wallet review failed; no decision saved."); }
    finally { reviewLock.current = false; setReviewing(false); }
  }
  function commit(update: (current: EmergencyRequest[]) => EmergencyRequest[]) {
    if (!ready || blocked) return;
    try {
      // Re-read inside a cross-tab lock; never overwrite a concurrent approval.
      if (!navigator.locks) throw new Error("Use a browser with Web Locks to safely update demo history.");
      void navigator.locks.request(KEY, async () => {
        try {
          const raw = localStorage.getItem(KEY);
          const next = update(raw ? readRequests(raw) : []);
          localStorage.setItem(KEY, JSON.stringify(next));
          setRequests(next); setMessage("");
        } catch (error) { setMessage(error instanceof Error ? error.message : "Unable to save demo history."); }
      }).catch(() => setMessage("Unable to lock demo history."));
    } catch (error) { setMessage(error instanceof Error ? error.message : "Unable to save demo history."); }
  }
  useEffect(() => {
    function sync(event: StorageEvent) {
      if (event.key !== KEY) return;
      try {
        const records = event.newValue ? readRequests(event.newValue) : [];
        setReady(false);
        setRequests(records.map(record => ({ ...record, approvals: [], status: "pending", decision: undefined })));
        void Promise.all(records.map(record => record.decision ? browserRequest<EmergencyRequest>("/api/emergency/approval", { request: record, verify: true }) : Promise.resolve(record))).then(setRequests).catch(() => { setBlocked(true); setMessage("Changed wallet approvals could not be verified; updates blocked."); }).finally(() => setReady(true));
      } catch { setBlocked(true); setMessage("Emergency history changed to an invalid record; updates blocked."); }
    }
    window.addEventListener("storage", sync);
    return () => window.removeEventListener("storage", sync);
  }, []);
  return <>
    <div className="pp-page-heading"><div><div className="pp-eyebrow">FAMILY SAFETY NET</div><h1>Emergency <span>support for your family.</span></h1><p>Recipient-specific requests, separate from Instant Padala.</p></div><span className="pp-soft-badge">Wallet approvals - Testnet</span></div>
    {message && <div className="pp-notice" role="status">{message}</div>}
    <div className="pp-payment-grid"><div className="pp-payment-main">
      <div className="pp-white-card"><h2>New emergency request</h2><p>Saved in this browser only. One approval from the active Freighter wallet is required. Signing an approval message does not send funds.</p>
        <form onSubmit={event => { event.preventDefault(); try { const request = createRequest(recipient, amount, reason); commit(current => [request, ...current]); setReason(""); } catch (error) { setMessage(error instanceof Error ? error.message : "Invalid request."); } }}>
          <label className="pp-form-label">Requester <select value={recipient} onChange={event => setRecipient(event.target.value as EmergencyRecipient)}>{EMERGENCY_RECIPIENTS.map(id => <option key={id} value={id}>{EMERGENCY_NAMES[id]}</option>)}</select></label>
          <label className="pp-form-label">Amount (0?10,000 USDC, positive only)<div className="pp-amount-field"><input inputMode="decimal" value={amount} onChange={event => setAmount(event.target.value)} required/><span>USDC</span></div></label>
          <label className="pp-form-label">Reason<div className="pp-amount-field"><input value={reason} onChange={event => setReason(event.target.value)} maxLength={180} required/></div></label>
          <button disabled={!ready || blocked} className="pp-primary-button" type="submit">Submit emergency request</button>
        </form>
      </div>
      <div className="pp-white-card"><h2>Emergency requests</h2><p>Approve or reject using your active Freighter wallet.</p>
        {!requests.length && <p>No requests yet.</p>}
        {requests.map(request => <div key={request.id} style={{ padding: "16px 0", borderBottom: "1px solid #e2ebe6" }}>
          <div className="pp-preview-row"><strong>{EMERGENCY_NAMES[request.requester]}</strong><strong>{request.amount} USDC</strong></div>
          <p>{request.reason}</p><p className="pp-muted">{new Date(request.createdAt).toLocaleString()} ? {request.status === "rejected" ? "Rejected" : request.status === "approved" ? "Approved - see payment status below" : "Pending"}</p>
          <p>{phpRate === null ? "PHP estimate unavailable" : `Estimated PHP ${new Intl.NumberFormat("en-PH", { maximumFractionDigits: 2 }).format(Number(request.amount) * phpRate)}`}</p>
          <div className="pp-approval-progress"><div style={{ width: `${request.approvals.length * 100}%` }}/></div><p>{request.approvals.length} of 1 wallet approval{request.approvals.length > 0 ? ` ? ${request.approvals.map(id => `${id.slice(0, 7)}...${id.slice(-5)}`).join(", ")}` : ""}</p>
          {request.status === "pending" && <div className="pp-button-row">{[true, false].map(approve => <button key={String(approve)} type="button" className="pp-outline-button" disabled={!ready || blocked || reviewing} onClick={() => void review(request, approve)}>{reviewing ? "Waiting for wallet..." : approve ? "Approve with active wallet" : "Reject with active wallet"}</button>)}</div>}
          {request.status === "approved" && <EmergencyPaymentPanel request={request} integration={integrations.find(item => item.recipient === request.requester)} expanded={confirmation === request.id} onReview={() => setConfirmation(request.id)} onClose={() => setConfirmation(null)}/>}
          <small>Request ID: {request.id}</small>
        </div>)}
      </div>

    </div><div className="pp-payment-side"><div className="pp-side-card"><h3>Payment safety</h3><p>Each requester has a separate Emergency Pot deployment. Emergency payments never open Instant Padala or its family split.</p><p>Approval requires a verified signature from the active wallet. Requests are still stored locally, not in a shared authenticated backend. There is no shared emergency balance connected.</p><p>Request history stays in this browser; payment attempts are durably retained by the local server. Paid requires verified on-chain transfers. Unknown outcomes never start a replacement payment.</p></div></div></div>
  </>;
}
