import "server-only";
import { Keypair } from "@stellar/stellar-sdk";
import { decisionMessage, type EmergencyIntegration, type EmergencyRecipient, type EmergencyRequest } from "@/lib/emergency";
import { toStroops } from "@/lib/amount";
import { verifyDecision } from "@/lib/emergency-approval";
import { emergencyConfiguration, emergencyIntegration } from "@/lib/emergency-paiflow";
import { emergencyPaiflow, PaiflowError } from "@/lib/paiflow";
import { EMERGENCY_TARGETS, confirmedEmergencyPayment, validateEmergencyEnvelope, validateEmergencyPreparation, verifyEmergencyTarget } from "@/lib/emergency-chain";
import { withEmergencyAttempt, publicEmergencyAttempt, EmergencyConflict, type EmergencyAttempt } from "@/lib/emergency-store";

export class EmergencyPaymentError extends Error {
  constructor(message: string, readonly status = 422, readonly code = "VALIDATION") { super(message); }
}
function approved(request: EmergencyRequest, origin: string) {
  const verified = verifyDecision(request, origin);
  if (verified.status !== "approved" || !verified.decision?.approve || verified.approvals.length !== 1) throw new EmergencyPaymentError("One verified wallet approval is required before payment.");
  return verified;
}
export async function emergencyDiscovery(recipient: EmergencyRecipient): Promise<EmergencyIntegration> {
  const configured = emergencyIntegration(recipient);
  if (!configured.configured) return configured;
  try {
    const deployment = emergencyConfiguration(recipient);
    const api = emergencyPaiflow(recipient);
    const [capabilities, target] = await Promise.all([api.capabilities(), verifyEmergencyTarget(recipient)]);
    if (capabilities.deploymentId !== deployment.deploymentId || capabilities.network !== "testnet" || capabilities.triggerType !== "deposit" || capabilities.inputAsset?.kind !== "known" || capabilities.inputAsset.symbol !== "USDC" || !["supported", "conditional"].includes(capabilities.operations.execute.status)) throw new Error("Deployment capability mismatch.");
    return { ...configured, ...target, paymentEnabled: true, message: "Recipient and full-amount Testnet USDC route verified. Freighter will authorize a separate payment from the approving wallet." };
  } catch {
    return { ...configured, paymentEnabled: false, message: "Payment unavailable: live deployment/contract verification failed or team mode is disabled. Check configuration and try refreshing." };
  }
}
function definitelyRefused(error: unknown) {
  return error instanceof PaiflowError && error.status >= 400 && error.status < 500 && ["VALIDATION", "FORBIDDEN", "UNAUTHENTICATED", "PREPARATION_MODE", "CONFIGURATION", "RATE_LIMITED", "INSUFFICIENT_FUNDS"].includes(error.api.code);
}
function preparationFailure(error: unknown) {
  if (error instanceof PaiflowError && error.api.code === "INSUFFICIENT_FUNDS") return "Preparation refused: check Testnet USDC balance and XLM for fees.";
  if (error instanceof PaiflowError && error.api.code === "RATE_LIMITED") return "Preparation refused: Paiflow rate limit reached. Wait before trying again.";
  if (definitelyRefused(error)) return "Preparation refused: check Testnet account funding, exact USDC trustlines and deployment eligibility. No transaction was signed.";
  return "Preparation unresolved. The original request is reserved; check its payment status before any other attempt.";
}
async function reconcile(attempt: EmergencyAttempt) {
  if (attempt.state === "paid" || attempt.state === "failed" || !attempt.txHash) return attempt;
  try {
    const upstream = await emergencyPaiflow(attempt.request.requester).status(attempt.txHash).catch(() => null);
    if (upstream && (upstream.txHash !== attempt.txHash || upstream.network !== "testnet")) throw new Error("Status response mismatch.");
    const proof = await confirmedEmergencyPayment(attempt.txHash, attempt.request.requester, attempt.payer, attempt.amount);
    if (proof.status === "SUCCESS") return { ...attempt, state: "paid" as const, ledger: proof.ledger, message: "Paid: confirmed Testnet USDC transfer of the exact amount to the intended recipient." };
    if (proof.status === "FAILED") return { ...attempt, state: "failed" as const, ledger: proof.ledger, message: "The transaction failed on-chain. No emergency payout succeeded. This attempt remains in history." };
    return { ...attempt, message: attempt.state === "prepared" ? "Original payment prepared. Sign this same transaction to continue; an expired or uncertain preparation is never silently replaced." : "Payment pending or outcome unknown. Keep the original transaction; check again rather than starting another payment." };
  } catch {
    return { ...attempt, message: "Confirmation temporarily unavailable. Keep the original transaction and check again; no replacement payment is allowed." };
  }
}
export async function emergencyPayment(request: EmergencyRequest, origin: string, phase: "prepare" | "submit" | "status", signedXdr?: string) {
  const verified = approved(request, origin);
  const config = emergencyConfiguration(verified.requester);
  // Enforce mode before accepting payment work, including recovery requests.
  const api = emergencyPaiflow(verified.requester);
  return withEmergencyAttempt(origin, verified.id, async (existing, save) => {
    if (existing && (existing.deploymentId !== config.deploymentId || existing.payer !== verified.decision!.signerAddress || decisionMessage(existing.request, true, origin) !== decisionMessage(verified, true, origin))) throw new EmergencyPaymentError("This request ID is already bound to another immutable payment.", 409, "CONFLICT");
    if (phase === "status") {
      if (!existing) return null;
      const next = await reconcile(existing); await save(next);
      return publicEmergencyAttempt(next);
    }
    if (phase === "prepare") {
      if (existing && existing.state !== "refused") return publicEmergencyAttempt(existing);
      const readiness = await emergencyDiscovery(verified.requester);
      if (!readiness.paymentEnabled) throw new EmergencyPaymentError(readiness.message, 503, "CONFIGURATION");
      let attempt: EmergencyAttempt = { version: 1, origin, request: verified, requestId: verified.id, deploymentId: config.deploymentId, payer: verified.decision!.signerAddress, wallet: EMERGENCY_TARGETS[verified.requester].wallet, amount: verified.amount, state: "reserved", message: "Original payment preparation reserved.", updatedAt: new Date().toISOString() };
      // Persist the reservation BEFORE touching a preparation API. If its response is
      // lost, another process/reload can never create a replacement for this request.
      await save(attempt);
      try {
        const prepared = validateEmergencyPreparation(await api.prepare(attempt.payer, toStroops(attempt.amount)), verified.requester, attempt.payer, attempt.amount);
        attempt = { ...attempt, prepared, txHash: prepared.txHash, state: "prepared", message: "Ready for Freighter confirmation. No payment has been submitted." };
        await save(attempt);
        return publicEmergencyAttempt(attempt);
      } catch (error) {
        const refused = definitelyRefused(error);
        await save({ ...attempt, state: refused ? "refused" : "reserved", message: preparationFailure(error) });
        throw new EmergencyPaymentError(preparationFailure(error), refused ? 422 : 503, refused ? "VALIDATION" : "UPSTREAM_RPC");
      }
    }
    if (!existing?.prepared || !existing.txHash) throw new EmergencyPaymentError("Recover the original preparation before submission.", 409, "CONFLICT");
    if (existing.state === "paid" || existing.state === "failed") return publicEmergencyAttempt(existing);
    if (!signedXdr) throw new EmergencyPaymentError("A signed payment transaction is required.");
    if (existing.signedXdr && existing.signedXdr !== signedXdr) throw new EmergencyPaymentError("Only the original signed envelope may be resubmitted.", 409, "CONFLICT");
    const tx = validateEmergencyEnvelope(signedXdr, verified.requester, existing.payer, existing.amount);
    if (Buffer.from(tx.hash()).toString("hex") !== existing.txHash || !tx.signatures.some(signature => Keypair.fromPublicKey(existing.payer).verify(tx.hash(), signature.signature.value))) throw new EmergencyPaymentError("The approving wallet must sign the original prepared transaction.");
    await verifyEmergencyTarget(verified.requester);
    // Exact signed envelope and possible-submission marker are durable before submit.
    let attempted: EmergencyAttempt = { ...existing, signedXdr, state: "pending", message: "Payment submitted or submission outcome unresolved. Check the original transaction." };
    await save(attempted);
    try {
      const result = await api.submit(signedXdr, existing.prepared.preparationRequestId);
      if (result.txHash !== existing.txHash) throw new Error("Submission hash mismatch.");
      // HTTP 200 or SUCCESS alone does not mark Paid. Independent RPC confirmation
      // must include the exact payer->trigger->Pay->recipient USDC transfer chain.
      attempted = await reconcile(attempted);
    } catch {
      attempted.message = "Submission outcome unresolved. The original signed transaction was saved; check status or resubmit that same envelope only.";
    }
    await save(attempted);
    return publicEmergencyAttempt(attempted);
  });
}
export { EmergencyConflict };
