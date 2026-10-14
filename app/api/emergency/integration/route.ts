import { EMERGENCY_RECIPIENTS, isEmergencyRecipient, readRequests } from "@/lib/emergency";
import { emergencyDiscovery, emergencyPayment, EmergencyConflict, EmergencyPaymentError } from "@/lib/emergency-payments";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function failure(error: unknown) {
  const known = error instanceof EmergencyPaymentError || error instanceof EmergencyConflict;
  return Response.json({ error: { code: error instanceof EmergencyPaymentError ? error.code : error instanceof EmergencyConflict ? "CONFLICT" : "UPSTREAM_RPC", message: known ? error.message : "Emergency payment could not be completed. Retain the original request and check its payment status." } }, { status: error instanceof EmergencyPaymentError ? error.status : error instanceof EmergencyConflict ? 409 : 503, headers: { "Cache-Control": "no-store" } });
}
export async function GET(request: Request) {
  const query = new URL(request.url).searchParams;
  if ([...query.keys()].some(key => key !== "recipient") || (query.has("recipient") && !isEmergencyRecipient(query.get("recipient")))) return Response.json({ error: { code: "VALIDATION", message: "Unsupported emergency recipient or query." } }, { status: 422 });
  const recipients = query.has("recipient") ? [query.get("recipient")!] : EMERGENCY_RECIPIENTS;
  try { return Response.json({ data: await Promise.all(recipients.map(recipient => emergencyDiscovery(recipient as typeof EMERGENCY_RECIPIENTS[number]))) }, { headers: { "Cache-Control": "no-store" } }); } catch (error) { return failure(error); }
}
export async function POST(request: Request) {
  const origin = new URL(request.url).origin;
  if (request.headers.get("origin") !== origin) return Response.json({ error: { code: "FORBIDDEN", message: "Same-origin requests required." } }, { status: 403 });
  let body;
  try {
    const text = await request.text();
    if (text.length > 220000) throw new Error("Payload too large.");
    body = JSON.parse(text);
    if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).some(key => !["phase", "request", "signedXdr"].includes(key)) || !["prepare", "submit", "status"].includes(body.phase) || (body.signedXdr !== undefined && (typeof body.signedXdr !== "string" || body.signedXdr.length > 200000)) || (body.phase !== "submit" && body.signedXdr !== undefined)) throw new Error("Invalid fields.");
    const [record] = readRequests(JSON.stringify([body.request]));
    if (!record || record.status !== "approved") throw new Error("Only approved requests can enter payment.");
    return Response.json({ data: await emergencyPayment(record, origin, body.phase, body.signedXdr) }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    if (!body || !(error instanceof EmergencyPaymentError || error instanceof EmergencyConflict)) {
      // Validation/signature/configuration errors never expose arbitrary input or
      // upstream details. Recovery stays in the durable request record.
      return failure(new EmergencyPaymentError("Invalid or unavailable approved payment. Verify its wallet approval, configuration and original payment status."));
    }
    return failure(error);
  }
}
