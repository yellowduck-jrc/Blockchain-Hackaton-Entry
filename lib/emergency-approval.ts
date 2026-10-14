import "server-only";
import { Keypair, hash } from "@stellar/stellar-sdk";
import { decisionMessage, decideRequest, type EmergencyRequest } from "@/lib/emergency";

export function verifyWalletSignature(message: string, signature: string, signerAddress: string): boolean {
  try {
    if (!/^[A-Za-z0-9+/]{86}==$/.test(signature)) return false;
    const digest = hash(Buffer.from(`Stellar Signed Message:\n${message}`, "utf8"));
    return Keypair.fromPublicKey(signerAddress).verify(digest, Buffer.from(signature, "base64"));
  } catch { return false; }
}
export function verifyDecision(request: EmergencyRequest, origin: string): EmergencyRequest {
  const proof = request.decision;
  if (!proof || proof.origin !== origin || !verifyWalletSignature(decisionMessage(request, proof.approve, origin), proof.signature, proof.signerAddress)) throw new Error("Approval signature is missing, invalid, or belongs to another site.");
  return { ...decideRequest({ ...request, status: "pending", approvals: [], decision: undefined }, proof.signerAddress, proof.approve), decision: proof };
}
