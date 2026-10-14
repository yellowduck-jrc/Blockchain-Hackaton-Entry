import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
vi.mock("@/lib/browser-api", () => ({ browserRequest: vi.fn() }));
vi.mock("@/lib/wallet", () => ({ connectWallet: vi.fn(), signPrepared: vi.fn() }));
import { EmergencyPaymentPanel } from "@/components/emergency-payment";
import { browserRequest } from "@/lib/browser-api";
import { connectWallet, signPrepared } from "@/lib/wallet";
import { createRequest, type EmergencyPayment, type EmergencyRequest } from "@/lib/emergency";
const wallet = `G${"A".repeat(55)}`;
let tree: ReactTestRenderer;
let record: EmergencyRequest;
let payment: EmergencyPayment;
const storage = new Map<string, string>();
beforeEach(() => {
  vi.clearAllMocks(); storage.clear();
  record = { ...createRequest("brother", "50", "Medical"), status: "approved", approvals: [wallet], decision: { signerAddress: wallet, signature: "a".repeat(86) + "==", approve: true, origin: "http://localhost" } };
  payment = { state: "prepared", requestId: record.id, deploymentId: "d34c35d4-10e0-4b59-9b98-425a1a503023", wallet: `G${"B".repeat(55)}`, payer: wallet, amount: "50", txHash: "a".repeat(64), prepared: { xdr: "original-preparation", network: "testnet", networkPassphrase: "Test SDF Network ; September 2015", expiresAt: new Date(Date.now() + 180000).toISOString(), txHash: "a".repeat(64) }, message: "Ready" };
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("localStorage", { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value), removeItem: (key: string) => storage.delete(key) });
  vi.stubGlobal("navigator", { locks: { request: async (_name: string, callback: () => Promise<void>) => callback() } });
  vi.mocked(connectWallet).mockResolvedValue(wallet);
  vi.mocked(signPrepared).mockResolvedValue("original-signed-envelope");
  vi.mocked(browserRequest).mockImplementation(async (_path, body) => {
    const phase = (body as { phase: string }).phase;
    return (phase === "status" ? null : phase === "prepare" ? payment : { ...payment, state: "paid", ledger: 123, message: "Confirmed" }) as never;
  });
});
afterEach(async () => { if (tree) await act(async () => tree.unmount()); vi.unstubAllGlobals(); });
async function render() {
  await act(async () => { tree = create(<EmergencyPaymentPanel request={record} integration={{ recipient: "brother", configured: true, paymentEnabled: true, deploymentId: payment.deploymentId, message: "Verified" }} expanded onReview={() => {}} onClose={() => {}}/>); });
}
function sendButton() { return tree.root.findAllByType("button").find(button => String(button.children.join(" ")).includes("Funds") || String(button.children.join(" ")).includes("Original Transaction"))!; }
it("preserves the original preparation and never submits after Freighter cancellation", async () => {
  vi.mocked(signPrepared).mockImplementation(async () => {
    expect(JSON.parse(storage.get(`padala-pabalik:emergency-payment:v1:${record.id}`)!).txHash).toBe(payment.txHash);
    throw new Error("User rejected");
  });
  await render(); expect(sendButton().props.disabled).toBe(false);
  await act(async () => { sendButton().props.onClick(); });
  expect(vi.mocked(browserRequest).mock.calls.some(([, body]) => (body as { phase: string }).phase === "submit")).toBe(false);
  expect(JSON.parse(storage.get(`padala-pabalik:emergency-payment:v1:${record.id}`)!).txHash).toBe(payment.txHash);
});
it("resumes only the locally saved original envelope when submit never reached the server", async () => {
  storage.set(`padala-pabalik:emergency-payment:v1:${record.id}`, JSON.stringify({ ...payment, signedXdr: "original-signed-envelope" }));
  vi.mocked(browserRequest).mockImplementation(async (_path, body) => (body as { phase: string }).phase === "status" ? payment as never : { ...payment, state: "paid", ledger: 123, message: "Confirmed" } as never);
  await render(); await act(async () => { sendButton().props.onClick(); });
  expect(signPrepared).not.toHaveBeenCalled();
  expect(vi.mocked(browserRequest).mock.calls.some(([, body]) => (body as { phase: string }).phase === "prepare")).toBe(false);
  expect(vi.mocked(browserRequest).mock.calls.find(([, body]) => (body as { phase: string }).phase === "submit")![1]).toMatchObject({ signedXdr: "original-signed-envelope" });
});
it("refuses a different active wallet before payment preparation", async () => {
  vi.mocked(connectWallet).mockResolvedValue(`G${"C".repeat(55)}`);
  await render(); await act(async () => { sendButton().props.onClick(); });
  expect(signPrepared).not.toHaveBeenCalled();
  expect(vi.mocked(browserRequest).mock.calls.some(([, body]) => (body as { phase: string }).phase !== "status")).toBe(false);
});
it("blocks a replacement if local payment evidence exists but the server record is missing", async () => {
  storage.set(`padala-pabalik:emergency-payment:v1:${record.id}`, JSON.stringify({ ...payment, signedXdr: "original-signed-envelope" }));
  await render(); expect(sendButton().props.disabled).toBe(true);
});
it("serializes duplicate send clicks and retains the signature before submission", async () => {
  vi.mocked(browserRequest).mockImplementation(async (_path, body) => {
    const phase = (body as { phase: string }).phase;
    if (phase === "submit") {
      expect(JSON.parse(storage.get(`padala-pabalik:emergency-payment:v1:${record.id}`)!).signedXdr).toBe("original-signed-envelope");
      return { ...payment, state: "paid", ledger: 123, message: "Confirmed" } as never;
    }
    return (phase === "prepare" ? payment : null) as never;
  });
  await render(); const button = sendButton();
  await act(async () => { button.props.onClick(); button.props.onClick(); });
  expect(signPrepared).toHaveBeenCalledTimes(1);
  expect(vi.mocked(browserRequest).mock.calls.filter(([, body]) => (body as { phase: string }).phase === "prepare")).toHaveLength(1);
  expect(vi.mocked(browserRequest).mock.calls.filter(([, body]) => (body as { phase: string }).phase === "submit")).toHaveLength(1);
});
