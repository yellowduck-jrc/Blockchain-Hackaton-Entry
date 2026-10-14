import { fromStroops, toStroops } from "@/lib/amount";

export const EMERGENCY_RECIPIENTS = ["parents", "brother", "sister"] as const;
export type EmergencyRecipient = typeof EMERGENCY_RECIPIENTS[number];
export type Approver = string;
export const EMERGENCY_NAMES: Record<EmergencyRecipient | "jun", string> = { parents: "Parents", brother: "Brother", sister: "Younger Sister", jun: "Jun" };
export type EmergencyStatus = "pending" | "approved" | "rejected" | "payment_pending" | "paid" | "failed";
export type EmergencyRequest = {
  id: string;
  requester: EmergencyRecipient;
  amount: string;
  reason: string;
  createdAt: string;
  approvals: Approver[];
  status: EmergencyStatus;
  decision?: { signerAddress: string; signature: string; origin: string; approve: boolean };
};
export function isEmergencyRecipient(value: unknown): value is EmergencyRecipient {
  return EMERGENCY_RECIPIENTS.some(id => id === value);
}
export function emergencyAmount(value: string, maximum = "10000"): string {
  const stroops = toStroops(value);
  if (BigInt(stroops) > BigInt(toStroops(maximum))) throw new Error(`Maximum emergency request is ${maximum} USDC.`);
  return fromStroops(stroops);
}
export function createRequest(requester: unknown, amount: string, reason: string): EmergencyRequest {
  if (!isEmergencyRecipient(requester)) throw new Error("Select a supported emergency recipient.");
  if (!reason.trim() || reason.trim().length > 180) throw new Error("Enter a reason of 1?180 characters.");
  return { id: crypto.randomUUID(), requester, amount: emergencyAmount(amount), reason: reason.trim(), createdAt: new Date().toISOString(), approvals: [], status: "pending" };
}
export function decisionMessage(request: EmergencyRequest, approve: boolean, origin: string): string {
  return JSON.stringify({ application: "Padala Pabalik Emergency Approval", version: 1, network: "testnet", origin, decision: approve ? "approve" : "reject", requestId: request.id, requester: request.requester, amountUSDC: request.amount, reason: request.reason, createdAt: request.createdAt });
}
export function decideRequest(request: EmergencyRequest, approver: string, approve: boolean): EmergencyRequest {
  if (request.status !== "pending") throw new Error("Only pending requests can be reviewed.");
  if (!/^G[A-Z2-7]{55}$/.test(approver)) throw new Error("Connect a Stellar wallet to review this request.");
  return { ...request, approvals: approve ? [approver] : [], status: approve ? "approved" : "rejected" };
}
export function readRequests(raw: string): EmergencyRequest[] {
  const items: unknown = JSON.parse(raw);
  if (!Array.isArray(items)) throw new Error("Invalid emergency history. Preserve the original storage for recovery.");
  return items.map((item: EmergencyRequest) => {
    if (!item || typeof item.id !== "string" || !/^[a-f0-9-]{36}$/i.test(item.id) || !isEmergencyRecipient(item.requester) || typeof item.amount !== "string" || emergencyAmount(item.amount) !== item.amount || typeof item.reason !== "string" || !item.reason.trim() || item.reason.length > 180 || typeof item.createdAt !== "string" || !Number.isFinite(Date.parse(item.createdAt)) || !Array.isArray(item.approvals) || !["pending", "approved", "rejected"].includes(item.status)) throw new Error("Invalid emergency history; payment statuses cannot be restored from approval records.");
    // Old simulated decisions lack wallet signatures. Preserve requests, reset review.
    if (!item.decision) return { ...item, approvals: [], status: "pending" };
    const proof = item.decision;
    if (typeof proof.signerAddress !== "string" || !/^G[A-Z2-7]{55}$/.test(proof.signerAddress) || typeof proof.signature !== "string" || !/^[A-Za-z0-9+/]{86}==$/.test(proof.signature) || typeof proof.origin !== "string" || proof.origin.length > 200 || typeof proof.approve !== "boolean" || item.status !== (proof.approve ? "approved" : "rejected") || item.approvals.length !== (proof.approve ? 1 : 0) || (proof.approve && item.approvals[0] !== proof.signerAddress)) throw new Error("Invalid wallet decision evidence.");
    return item;
  });
}
export type EmergencyIntegration = {
  recipient: EmergencyRecipient;
  deploymentId: string | null;
  configured: boolean;
  paymentEnabled: boolean;
  wallet?: string;
  trigger?: string;
  message: string;
};

export type EmergencyPayment = {
  state: "reserved" | "prepared" | "pending" | "paid" | "failed" | "refused";
  requestId: string;
  deploymentId: string;
  wallet: string;
  amount: string;
  payer: string;
  txHash?: string;
  prepared?: { xdr: string; network: "testnet"; networkPassphrase: string; expiresAt: string; txHash: string; preparationRequestId?: string };
  signedXdr?: string;
  ledger?: number;
  message: string;
};
