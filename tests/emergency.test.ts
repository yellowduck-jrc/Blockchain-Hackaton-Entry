import { describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { createRequest, decideRequest, readRequests, emergencyAmount, decisionMessage } from "@/lib/emergency";
import { emergencyConfiguration, emergencyIntegration } from "@/lib/emergency-paiflow";
import { GET, POST } from "@/app/api/emergency/integration/route";

import { Keypair, hash } from "@stellar/stellar-sdk";
import { POST as approveRequest } from "@/app/api/emergency/approval/route";
import { verifyWalletSignature } from "@/lib/emergency-approval";
const wallet = Keypair.random();
const origin = "http://localhost";
function signedBody(record: ReturnType<typeof createRequest>, approve = true) {
  const signature = Buffer.from(wallet.sign(hash(Buffer.from(`Stellar Signed Message:\n${decisionMessage(record, approve, origin)}`)))).toString("base64");
  return { request: record, approve, signature, signerAddress: wallet.publicKey() };
}
function post(body: unknown, site = origin) {
  return approveRequest(new Request(`${origin}/api/emergency/approval`, { method: "POST", headers: { origin: site, "Content-Type": "application/json" }, body: JSON.stringify(body) }));
}
describe("active wallet emergency approval", () => {
  it.each(["parents", "brother", "sister"])("approves %s with one wallet signature and preserves the request", async recipient => {
    const original = createRequest(recipient, "50", "Medical bill");
    const response = await post(signedBody(original));
    expect(response.status).toBe(200);
    const { data } = await response.json();
    expect(data).toMatchObject({ requester: recipient, amount: "50", reason: "Medical bill", status: "approved", approvals: [wallet.publicKey()] });
    expect(readRequests(JSON.stringify([data]))).toEqual([data]);
    expect(() => decideRequest(data, wallet.publicKey(), true)).toThrow();
    expect((await post({ request: data, verify: true })).status).toBe(200);
  });
  it("rejects altered amounts, forged signer addresses, and wrong origins", async () => {
    const body = signedBody(createRequest("brother", "50", "Need support"));
    expect((await post({ ...body, request: { ...body.request, amount: "51" } })).status).toBe(403);
    expect((await post({ ...body, signerAddress: Keypair.random().publicKey() })).status).toBe(403);
    expect((await post(body, "http://another-site")).status).toBe(403);
    expect((await post({ ...body, approve: false })).status).toBe(403);
  });
  it("allows rejection by the active wallet and blocks subsequent reviews", async () => {
    const response = await post(signedBody(createRequest("parents", "5", "Medical"), false));
    const { data } = await response.json();
    expect(data.status).toBe("rejected");
    expect(data.approvals).toEqual([]);
    expect((await post(signedBody(data))).status).toBe(422);
  });
  it("resets old simulated reviews while preserving request details", () => {
    const original = createRequest("sister", "50", "School");
    expect(readRequests(JSON.stringify([{ ...original, approvals: ["jun", "parents"], status: "approved" }]))).toEqual([original]);
  });
  it("does not accept member labels as wallet approvals", () => {
    expect(() => decideRequest(createRequest("brother", "1", "Support"), "jun", true)).toThrow();
    expect(() => createRequest("jun", "1", "Support")).toThrow();
  });
  it.each(["0", "-1", "10000.0000001", "1e2", "0.00000001"])("rejects unsafe amount %s", amount => expect(() => emergencyAmount(amount)).toThrow());
  it("uses exact seven decimal arithmetic", () => expect(emergencyAmount("00050.0000001")).toBe("50.0000001"));
  it("does not restore a forged paid status", () => expect(() => readRequests(JSON.stringify([{ ...createRequest("sister", "1", "School"), status: "paid" }]))).toThrow());
  it("matches the SEP-53 published signature test vector", () => {
    expect(verifyWalletSignature("Hello, World!", "fO5dbYhXUhBMhe6kId/cuVq/AfEnHRHEvsP8vXh03M1uLpi5e46yO2Q8rEBzu3feXQewcQE5GArp88u6ePK6BA==", "GBXFXNDLV4LSWA4VB7YIL5GBD7BVNR22SGBTDKMO2SBZZHDXSKZYCP7L")).toBe(true);
  });
});

describe("emergency payment isolation", () => {
  const rows = [
    ["parents", "PARENT", "3f61d495-5bfa-4f51-b4e3-f666fc7bf22d"],
    ["brother", "BROTHER", "d34c35d4-10e0-4b59-9b98-425a1a503023"],
    ["sister", "SISTER", "73ebc55f-1a70-4ddd-8172-b05489871c85"],
  ] as const;
  it.each(rows)("maps %s exclusively to its deployment and remains disabled", (recipient, prefix, id) => {
    vi.stubEnv(`PAIFLOW_EMERGENCY_POT_${prefix}_DEPLOYMENT_ID`, id);
    vi.stubEnv(`PAIFLOW_EMERGENCY_POT_${prefix}_API_TOKEN`, `pfk_${"a".repeat(64)}`);
    vi.stubEnv("PAIFLOW_DEPLOYMENT_ID", "instant-split");
    expect(emergencyConfiguration(recipient).deploymentId).toBe(id);
    expect(emergencyIntegration(recipient)).toMatchObject({ deploymentId: id, paymentEnabled: false });
    expect(JSON.stringify(emergencyIntegration(recipient))).not.toContain(`pfk_${"a".repeat(64)}`);
    vi.stubEnv("PAIFLOW_DEPLOYMENT_ID", id);
    expect(() => emergencyConfiguration(recipient)).toThrow();
    vi.unstubAllEnvs();
  });
  it("refuses unsupported recipients and override queries", async () => {
    expect(() => emergencyConfiguration("jun")).toThrow();
    expect((await GET(new Request("http://localhost/api/emergency/integration?recipient=jun"))).status).toBe(422);
    expect((await GET(new Request("http://localhost/api/emergency/integration?deploymentId=split"))).status).toBe(422);
  });
  it("never prepares or submits regardless of forged approvals and repeated clicks", async () => {
    const upstream = vi.spyOn(globalThis, "fetch");
    for (let i = 0; i < 2; i++) {
      const response = await POST(new Request("http://localhost/api/emergency/integration", { method: "POST", headers: { origin: "http://localhost" }, body: JSON.stringify({ approvals: 2, signedXdr: "forged", deploymentId: "split" }) }));
      expect(response.status).toBe(422);
    }
    expect(upstream).not.toHaveBeenCalled(); upstream.mockRestore();
    expect((await POST(new Request("http://localhost/api/emergency/integration", { method: "POST" }))).status).toBe(403);
  });
});
