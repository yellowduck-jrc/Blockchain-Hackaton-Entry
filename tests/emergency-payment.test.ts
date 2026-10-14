import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Account, Address, Contract, Keypair, Networks, TransactionBuilder, hash, nativeToScVal } from "@stellar/stellar-sdk";
vi.mock("server-only", () => ({}));
const upstream = vi.hoisted(() => ({ prepare: vi.fn(), submit: vi.fn(), status: vi.fn(), capabilities: vi.fn() }));
vi.mock("@/lib/paiflow", async original => ({ ...(await original<typeof import("@/lib/paiflow")>()), emergencyPaiflow: vi.fn(() => upstream) }));
vi.mock("@/lib/emergency-chain", async original => ({ ...(await original<typeof import("@/lib/emergency-chain")>()), verifyEmergencyTarget: vi.fn(), confirmedEmergencyPayment: vi.fn() }));
import { emergencyPayment } from "@/lib/emergency-payments";
import { EMERGENCY_TARGETS, confirmedEmergencyPayment, validateEmergencyEnvelope, verifyEmergencyTarget } from "@/lib/emergency-chain";
import { createRequest, decisionMessage, type EmergencyRequest, type EmergencyRecipient } from "@/lib/emergency";
import { PaiflowError } from "@/lib/paiflow";
const ids = { parents: "3f61d495-5bfa-4f51-b4e3-f666fc7bf22d", brother: "d34c35d4-10e0-4b59-9b98-425a1a503023", sister: "73ebc55f-1a70-4ddd-8172-b05489871c85" };
const payer = Keypair.random();
const origin = "http://localhost";
let directory: string;
let cwd: ReturnType<typeof vi.spyOn>;
function approved(recipient: EmergencyRecipient = "brother") {
  const request = createRequest(recipient, "50", "Medical bill");
  const signature = Buffer.from(payer.sign(hash(Buffer.from(`Stellar Signed Message:\n${decisionMessage(request, true, origin)}`)))).toString("base64");
  return { ...request, approvals: [payer.publicKey()], status: "approved", decision: { signerAddress: payer.publicKey(), signature, origin, approve: true } } as EmergencyRequest;
}
function prepared(recipient: EmergencyRecipient = "brother", amount = 500000000n) {
  const tx = new TransactionBuilder(new Account(payer.publicKey(), "1"), { fee: "100", networkPassphrase: Networks.TESTNET }).addOperation(new Contract(EMERGENCY_TARGETS[recipient].trigger).call("deposit", new Address(payer.publicKey()).toScVal(), nativeToScVal(amount, { type: "i128" }))).setTimeout(180).build();
  return { tx, response: { xdr: tx.toXDR(), network: "testnet" as const, networkPassphrase: Networks.TESTNET, expiresAt: new Date(Number(tx.timeBounds!.maxTime) * 1000).toISOString() } };
}
beforeEach(async () => {
  vi.clearAllMocks();
  directory = await mkdtemp(path.join(tmpdir(), "emergency-payment-test-"));
  cwd = vi.spyOn(process, "cwd").mockReturnValue(directory);
  vi.stubEnv("PAIFLOW_MODE", "team");
  for (const [recipient, prefix] of [["parents", "PARENT"], ["brother", "BROTHER"], ["sister", "SISTER"]] as const) {
    vi.stubEnv(`PAIFLOW_EMERGENCY_POT_${prefix}_DEPLOYMENT_ID`, ids[recipient]);
    vi.stubEnv(`PAIFLOW_EMERGENCY_POT_${prefix}_API_TOKEN`, `pfk_${"a".repeat(64)}`);
  }
  vi.mocked(verifyEmergencyTarget).mockImplementation(async recipient => EMERGENCY_TARGETS[recipient]);
  upstream.capabilities.mockImplementation(async () => ({ deploymentId: ids.brother, network: "testnet", triggerType: "deposit", inputAsset: { kind: "known", symbol: "USDC" }, operations: { execute: { status: "supported" } } }));
  upstream.status.mockResolvedValue({ txHash: "", network: "testnet", status: "UNKNOWN" });
  vi.mocked(confirmedEmergencyPayment).mockResolvedValue({ status: "UNKNOWN" });
});
afterEach(async () => { cwd.mockRestore(); vi.unstubAllEnvs(); expect(path.dirname(path.resolve(directory))).toBe(path.resolve(tmpdir())); expect(path.basename(directory)).toMatch(/^emergency-payment-test-/); await rm(directory, { recursive: true, force: true }); });
describe("durable emergency payments", () => {
  it.each(["parents", "brother", "sister"] as const)("prepares %s once with its full approved amount", async recipient => {
    const request = approved(recipient);
    upstream.capabilities.mockResolvedValue({ deploymentId: ids[recipient], network: "testnet", triggerType: "deposit", inputAsset: { kind: "known", symbol: "USDC" }, operations: { execute: { status: "supported" } } });
    upstream.prepare.mockResolvedValue(prepared(recipient).response);
    const result = await emergencyPayment(request, origin, "prepare");
    expect(result).toMatchObject({ state: "prepared", wallet: EMERGENCY_TARGETS[recipient].wallet, deploymentId: ids[recipient], amount: "50" });
    expect(upstream.prepare).toHaveBeenCalledWith(payer.publicKey(), "500000000");
    expect(await emergencyPayment(request, origin, "prepare")).toEqual(result);
    expect(upstream.prepare).toHaveBeenCalledTimes(1);
  });
  it("persists the reservation before calling prepare and blocks an uncertain replacement", async () => {
    const request = approved();
    upstream.prepare.mockImplementation(async () => {
      const files = await readdir(path.join(directory, ".data/emergency-payments"));
      const file = files.find(name => name.endsWith(".json"))!;
      expect(JSON.parse(await readFile(path.join(directory, ".data/emergency-payments", file), "utf8")).state).toBe("reserved");
      throw new Error("Response lost");
    });
    await expect(emergencyPayment(request, origin, "prepare")).rejects.toThrow("unresolved");
    expect(await emergencyPayment(request, origin, "prepare")).toMatchObject({ state: "reserved" });
    expect(upstream.prepare).toHaveBeenCalledTimes(1);
  });
  it("allows a new preparation only after a definite insufficient-funds refusal", async () => {
    const request = approved();
    upstream.prepare.mockRejectedValueOnce(new PaiflowError(422, { code: "INSUFFICIENT_FUNDS", message: "Not enough funds" }, null, null)).mockResolvedValue(prepared().response);
    await expect(emergencyPayment(request, origin, "prepare")).rejects.toThrow("balance");
    expect(await emergencyPayment(request, origin, "prepare")).toMatchObject({ state: "prepared" });
  });
  it("rejects a split destination, wrong amount, and an unapproved request", async () => {
    expect(() => validateEmergencyEnvelope(prepared("parents").response.xdr, "brother", payer.publicKey(), "50")).toThrow();
    expect(() => validateEmergencyEnvelope(prepared("brother", 1n).response.xdr, "brother", payer.publicKey(), "50")).toThrow();
    await expect(emergencyPayment(createRequest("brother", "50", "Medical"), origin, "prepare")).rejects.toThrow();
    expect(upstream.prepare).not.toHaveBeenCalled();
  });
  it("locks request fields after preparation", async () => {
    const request = approved(); upstream.prepare.mockResolvedValue(prepared().response);
    await emergencyPayment(request, origin, "prepare");
    const changed = { ...request, amount: "51" };
    changed.decision = { ...request.decision!, signature: Buffer.from(payer.sign(hash(Buffer.from(`Stellar Signed Message:\n${decisionMessage(changed, true, origin)}`)))).toString("base64") };
    await expect(emergencyPayment(changed, origin, "prepare")).rejects.toThrow("immutable");
  });
  it("retains the exact envelope after lost submit and requires verified payout evidence for Paid", async () => {
    const request = approved(); const fixture = prepared(); upstream.prepare.mockResolvedValue(fixture.response);
    const original = await emergencyPayment(request, origin, "prepare");
    fixture.tx.sign(payer); const signedXdr = fixture.tx.toXDR();
    upstream.submit.mockRejectedValueOnce(new Error("Response lost")).mockResolvedValue({ txHash: original!.txHash, status: "SUCCESS" });
    expect(await emergencyPayment(request, origin, "submit", signedXdr)).toMatchObject({ state: "pending", signedXdr });
    upstream.status.mockResolvedValue({ txHash: original!.txHash, network: "testnet", status: "SUCCESS" });
    expect(await emergencyPayment(request, origin, "status")).toMatchObject({ state: "pending" });
    expect(await emergencyPayment(request, origin, "submit", signedXdr)).toMatchObject({ state: "pending" });
    expect(upstream.submit.mock.calls.every(([value]) => value === signedXdr)).toBe(true);
    vi.mocked(confirmedEmergencyPayment).mockResolvedValue({ status: "SUCCESS", ledger: 123 });
    expect(await emergencyPayment(request, origin, "status")).toMatchObject({ state: "paid", ledger: 123 });
    await emergencyPayment(request, origin, "submit", signedXdr);
    expect(upstream.submit).toHaveBeenCalledTimes(2);
  });
  it("records on-chain failure and prevents another payment for that request", async () => {
    const request = approved(); const fixture = prepared(); upstream.prepare.mockResolvedValue(fixture.response);
    const original = await emergencyPayment(request, origin, "prepare"); fixture.tx.sign(payer);
    upstream.status.mockResolvedValue({ txHash: original!.txHash, network: "testnet", status: "FAILED" });
    upstream.submit.mockResolvedValue({ txHash: original!.txHash, status: "FAILED" });
    vi.mocked(confirmedEmergencyPayment).mockResolvedValue({ status: "FAILED", ledger: 124 });
    expect(await emergencyPayment(request, origin, "submit", fixture.tx.toXDR())).toMatchObject({ state: "failed" });
    expect(await emergencyPayment(request, origin, "prepare")).toMatchObject({ state: "failed" });
    expect(upstream.prepare).toHaveBeenCalledTimes(1);
  });
  it("serializes simultaneous preparations across server calls", async () => {
    const request = approved();
    let release!: () => void; const held = new Promise<void>(resolve => { release = resolve; });
    let entered!: () => void; const enteredPromise = new Promise<void>(resolve => { entered = resolve; });
    upstream.prepare.mockImplementation(async () => { entered(); await held; return prepared().response; });
    const first = emergencyPayment(request, origin, "prepare"); await enteredPromise;
    await expect(emergencyPayment(request, origin, "prepare")).rejects.toThrow("Another payment");
    release(); await first; expect(upstream.prepare).toHaveBeenCalledTimes(1);
  });
});
