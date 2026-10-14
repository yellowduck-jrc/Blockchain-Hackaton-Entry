"use client";
import { useEffect, useRef, useState } from "react";
import { browserRequest } from "@/lib/browser-api";
import { connectWallet, signPrepared } from "@/lib/wallet";
import { EMERGENCY_NAMES, type EmergencyIntegration, type EmergencyPayment, type EmergencyRequest } from "@/lib/emergency";

const ENDPOINT = "/api/emergency/integration";
export function EmergencyPaymentPanel({ request, integration, expanded, onReview, onClose }: { request: EmergencyRequest; integration?: EmergencyIntegration; expanded: boolean; onReview: () => void; onClose: () => void }) {
  const [payment, setPayment] = useState<EmergencyPayment | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const lock = useRef(false);
  const storageBlocked = useRef(false);
  const key = `padala-pabalik:emergency-payment:v1:${request.id}`;
  const evidence = JSON.stringify(request);
  function writeLocal(storageKey: string, value: string) {
    try { localStorage.setItem(storageKey, value); }
    catch { storageBlocked.current = true; throw new Error("Recovery storage unavailable. Payment stopped before any further signing or submission; retain the original server attempt."); }
  }
  function remember(value: EmergencyPayment) {
    writeLocal(key, JSON.stringify(value));
    setPayment(value);
  }
  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    setLoaded(false);
    async function check() {
      try {
        if (lock.current) { timer = setTimeout(check, 5000); return; }
        const value = await browserRequest<EmergencyPayment | null>(ENDPOINT, { phase: "status", request: JSON.parse(evidence) });
        if (cancelled) return;
        if (value) {
          // Preserve a locally signed envelope when submit never reached the server.
          const saved = localStorage.getItem(key);
          const local: EmergencyPayment | null = saved ? JSON.parse(saved) : null;
          const next = value.prepared && local?.txHash === value.txHash && local?.signedXdr && !value.signedXdr ? { ...value, signedXdr: local.signedXdr } : value;
          remember(next);
          setMessage(next.message);
          if (next.state === "reserved") timer = setTimeout(check, 30000);
        } else {
          if (localStorage.getItem(key)) {
            storageBlocked.current = true;
            setMessage("Local payment evidence exists but the durable server record is missing. Restore the server record before continuing; do not start a replacement.");
          } else { setPayment(null); }
        }
        setLoaded(true);
      } catch (error) {
        if (cancelled) return;
        setMessage(error instanceof Error ? error.message : "Original payment status unavailable. Check again.");
        timer = setTimeout(check, 15000);
      }
    }
    void check();
    return () => { cancelled = true; clearTimeout(timer); };
  }, [evidence, key]);
  async function send() {
    if (lock.current || !loaded || storageBlocked.current) return;
    lock.current = true; setBusy(true); setMessage("");
    try {
      if (!navigator.locks) throw new Error("Use a browser with Web Locks to serialize emergency payments.");
      await navigator.locks.request(key, async () => {
        const address = await connectWallet();
        if (address !== request.decision?.signerAddress) throw new Error("Switch Freighter to the wallet that approved this request before authorizing its payment.");
        // Recheck server state inside the tab lock. An existing attempt always wins.
        let current = await browserRequest<EmergencyPayment | null>(ENDPOINT, { phase: "status", request });
        if (!current && localStorage.getItem(key)) throw new Error("Local transaction evidence exists but the server record is missing. Restore it before continuing.");
        if (!current || current.state === "refused") {
          // Record that a prepare request may reach the server before making it.
          writeLocal(`${key}:preparing`, JSON.stringify({ requestId: request.id, deploymentId: integration?.deploymentId, payer: address }));
          current = await browserRequest<EmergencyPayment>(ENDPOINT, { phase: "prepare", request });
        }
        if (!current) throw new Error("Original payment preparation unavailable.");
        const saved = localStorage.getItem(key);
        const local: EmergencyPayment | null = saved ? JSON.parse(saved) : null;
        if (local?.txHash === current.txHash && local?.signedXdr && !current.signedXdr) current = { ...current, signedXdr: local.signedXdr };
        remember(current);
        localStorage.removeItem(`${key}:preparing`);
        if (current.state === "paid" || current.state === "failed" || current.state === "reserved") { setMessage(current.message); return; }
        if (!current.prepared) throw new Error("Recover the original preparation; do not create a replacement.");
        if (!current.signedXdr) {
          writeLocal(key, JSON.stringify({ ...current, signing: true }));
          if (Date.parse(current.prepared.expiresAt) <= Date.now()) throw new Error("Original transaction expired. Check its original status; do not create a replacement while unresolved.");
          setMessage("Confirm the recipient-specific payment in Freighter.");
          const signedXdr = await signPrepared(current.prepared, current.payer);
          current = { ...current, signedXdr };
          remember(current); // exact envelope retained BEFORE any submit request
        }
        setMessage("Submitting the original transaction and checking its on-chain payout...");
        const result = await browserRequest<EmergencyPayment>(ENDPOINT, { phase: "submit", request, signedXdr: current.signedXdr });
        remember(result);
        setMessage(result.message);
      });
    } catch (error) {
      setMessage(error instanceof Error ? /prepare again/i.test(error.message) ? "Original transaction could not be signed. Reconnect the approving wallet and check this original payment; do not create a replacement." : error.message : "Payment unresolved. Keep the original request and transaction.");
      try {
        const recovered = await browserRequest<EmergencyPayment | null>(ENDPOINT, { phase: "status", request });
        if (recovered) {
          const saved = localStorage.getItem(key);
          const local: EmergencyPayment | null = saved ? JSON.parse(saved) : null;
          remember(local?.txHash === recovered.txHash && local?.signedXdr && !recovered.signedXdr ? { ...recovered, signedXdr: local.signedXdr } : recovered);
        }
      } catch { /* Leave original envelope and server reservation intact. */ }
    } finally { lock.current = false; setBusy(false); }
  }
  // Submission starts polling without ever opening/signing another wallet operation.
  useEffect(() => {
    if (payment?.state !== "pending" || busy) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    async function poll() {
      try {
        const value = await browserRequest<EmergencyPayment>(ENDPOINT, { phase: "status", request: JSON.parse(evidence) });
        if (!cancelled && value) { remember(value); setMessage(value.message); }
      } catch { if (!cancelled) setMessage("Confirmation unavailable. Keep the original payment and check again."); }
      if (!cancelled) timer = setTimeout(poll, 15000);
    }
    timer = setTimeout(poll, 10000);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [payment?.state, busy, evidence, key]);
  const label = payment?.state === "paid" ? "Paid" : payment?.state === "failed" ? "Failed" : payment?.state === "pending" || payment?.state === "reserved" ? "Payment Pending" : "Approved";
  const resumable = payment?.state === "prepared" || payment?.state === "pending";
  const canSend = loaded && !busy && !storageBlocked.current && (resumable || integration?.paymentEnabled) && !["paid", "failed", "reserved"].includes(payment?.state ?? "");
  return <>
    <p role="status"><strong>{label}</strong>{payment?.ledger ? ` - confirmed ledger ${payment.ledger}` : ""}</p>
    {payment?.txHash && ["pending", "paid", "failed"].includes(payment.state) && <a className="pp-link-button" href={`https://stellar.expert/explorer/testnet/tx/${payment.txHash}`} target="_blank" rel="noreferrer">View Testnet transaction</a>}
    {!expanded && <button type="button" className="pp-secondary-button" onClick={onReview}>Review emergency payment</button>}
    {expanded && <div className="pp-white-card" role="region" aria-label="Emergency payment confirmation">
      <h2>Confirm emergency payment</h2><p>Recipient: <strong>{EMERGENCY_NAMES[request.requester]}</strong></p><p>Full amount: <strong>{request.amount} USDC</strong></p>
      <p>Recipient wallet: <span className="pp-address">{payment?.wallet ?? integration?.wallet ?? "Checking verified recipient..."}</span></p>
      <p>Deployment: <span className="pp-address">{payment?.deploymentId ?? integration?.deploymentId ?? "Checking deployment..."}</span></p>
      <p>Paying wallet: <span className="pp-address">{payment?.payer ?? request.decision?.signerAddress}</span></p>
      <p role="status">{message || (!loaded ? "Checking the original payment attempt..." : integration?.message ?? "Live deployment verification unavailable.")}</p>
      {payment?.txHash && <p>Original transaction: <span className="pp-address">{payment.txHash}</span></p>}
      <button type="button" className="pp-primary-button" disabled={!canSend} onClick={() => void send()}>{busy ? "Waiting for wallet / confirmation..." : resumable ? payment?.signedXdr ? "Resubmit Original Transaction" : "Sign Original Transaction" : "Send Emergency Funds"}</button>
      <button type="button" className="pp-text-button" disabled={busy} onClick={onClose}>Close</button>
      <p>Testnet only. Payment comes from the approving wallet. Approval does not transfer funds; Paid requires a confirmed USDC payout to this recipient.</p>
    </div>}
  </>;
}
