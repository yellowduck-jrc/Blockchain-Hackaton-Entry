import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
vi.mock("@/lib/browser-api", () => ({ browserRequest: vi.fn() }));
vi.mock("@/lib/wallet", () => ({ connectWallet: vi.fn(), refreshWallet: vi.fn() }));
vi.mock("@stellar/freighter-api", () => ({ signMessage: vi.fn(), getNetworkDetails: vi.fn() }));
import { EmergencyPot } from "@/components/emergency-pot";
import { browserRequest } from "@/lib/browser-api";
import { connectWallet, refreshWallet } from "@/lib/wallet";
import { signMessage, getNetworkDetails } from "@stellar/freighter-api";
import { createRequest } from "@/lib/emergency";
const key = "padala-pabalik-emergency-v3";
const address = `G${"A".repeat(55)}`;
let tree: ReactTestRenderer;
let raw: string;
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  raw = JSON.stringify([createRequest("brother", "50", "Medical")]);
  vi.stubGlobal("localStorage", { getItem: (name: string) => name === key ? raw : null, setItem: (_name: string, value: string) => { raw = value; } });
  vi.stubGlobal("navigator", { locks: { request: async (_name: string, callback: () => Promise<void>) => callback() } });
  vi.stubGlobal("window", { location: { origin: "http://localhost" }, addEventListener: vi.fn(), removeEventListener: vi.fn() });
  vi.mocked(browserRequest).mockResolvedValue([]);
  vi.mocked(connectWallet).mockResolvedValue(address);
  vi.mocked(refreshWallet).mockResolvedValue(address);
  vi.mocked(getNetworkDetails).mockResolvedValue({ network: "TESTNET", networkUrl: "https://soroban-testnet.stellar.org", networkPassphrase: "Test SDF Network ; September 2015" });
});
afterEach(async () => { if (tree) await act(async () => tree.unmount()); vi.unstubAllGlobals(); });
async function clickApprove() {
  await act(async () => { tree = create(<EmergencyPot phpRate={null}/>); });
  const button = tree.root.findAllByType("button").find(item => item.children.includes("Approve with active wallet"));
  expect(button).toBeDefined();
  await act(async () => { button!.props.onClick(); });
}
it("keeps the request pending when Freighter rejects the message", async () => {
  vi.mocked(signMessage).mockResolvedValue({ signedMessage: null, signerAddress: "", error: { code: -1, message: "User rejected" } });
  await clickApprove();
  expect(JSON.parse(raw)[0].status).toBe("pending");
  expect(vi.mocked(browserRequest).mock.calls.some(([path]) => path === "/api/emergency/approval")).toBe(false);
});
it("refuses approval if the active wallet changes during signing", async () => {
  vi.mocked(signMessage).mockResolvedValue({ signedMessage: "a".repeat(86) + "==", signerAddress: address });
  vi.mocked(refreshWallet).mockResolvedValue(`G${"B".repeat(55)}`);
  await clickApprove();
  expect(JSON.parse(raw)[0].status).toBe("pending");
  expect(vi.mocked(browserRequest).mock.calls.some(([path]) => path === "/api/emergency/approval")).toBe(false);
});
