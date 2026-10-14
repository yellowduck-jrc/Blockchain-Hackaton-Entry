import { decisionMessage, decideRequest, readRequests, type EmergencyRequest } from "@/lib/emergency";
import { verifyDecision, verifyWalletSignature } from "@/lib/emergency-approval";

export async function POST(request: Request) {
  const origin = new URL(request.url).origin;
  if (request.headers.get("origin") !== origin) return Response.json({ error: { code: "FORBIDDEN", message: "Same-origin requests required." } }, { status: 403 });
  try {
    if (Number(request.headers.get("content-length")) > 16000) throw new Error("Approval payload too large.");
    const raw = await request.text();
    if (raw.length > 16000) throw new Error("Approval payload too large.");
    const body = JSON.parse(raw);
    if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).some(key => !["request", "signature", "signerAddress", "approve", "verify"].includes(key))) throw new Error("Invalid approval fields.");
    if (body.verify === true) {
      const [record] = readRequests(JSON.stringify([body.request]));
      if (!record) throw new Error("Missing request.");
      return Response.json({ data: verifyDecision(record, origin) }, { headers: { "Cache-Control": "no-store" } });
    }
    const [record] = readRequests(JSON.stringify([body.request]));
    if (!record) throw new Error("Missing request.");
    if (record.status !== "pending" || typeof body.approve !== "boolean" || typeof body.signature !== "string" || typeof body.signerAddress !== "string") throw new Error("A pending request and wallet signature are required.");
    if (!verifyWalletSignature(decisionMessage(record, body.approve, origin), body.signature, body.signerAddress)) return Response.json({ error: { code: "FORBIDDEN", message: "The active wallet's signature could not be verified." } }, { status: 403 });
    const decided: EmergencyRequest = { ...decideRequest(record, body.signerAddress, body.approve), decision: { signerAddress: body.signerAddress, signature: body.signature, origin, approve: body.approve } };
    return Response.json({ data: decided }, { headers: { "Cache-Control": "no-store" } });
  } catch {
    return Response.json({ error: { code: "VALIDATION", message: "Invalid request or wallet decision evidence." } }, { status: 422 });
  }
}
