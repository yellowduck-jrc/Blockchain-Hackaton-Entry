import { expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { Address, Keypair, nativeToScVal, xdr } from "@stellar/stellar-sdk";
import { EMERGENCY_TARGETS, EMERGENCY_USDC, payoutEventsMatch } from "@/lib/emergency-chain";
const payer = Keypair.random().publicKey();
function event(from: string, to: string, amount = 500000000n, token = EMERGENCY_USDC) {
  const contract = new Address(token).toScAddress();
  if (contract.type !== "scAddressTypeContract") throw new Error("Expected contract.");
  return new xdr.ContractEvent({ ext: xdr.ExtensionPoint.v0(), contractId: contract.contractId, type: xdr.ContractEventType.contract, body: xdr.ContractEventBody.v0(new xdr.ContractEventV0({ topics: [nativeToScVal("transfer", { type: "symbol" }), new Address(from).toScVal(), new Address(to).toScVal(), nativeToScVal("USDC")], data: nativeToScVal(amount, { type: "i128" }) })) });
}
it.each(["parents", "brother", "sister"] as const)("confirms only the exact %s transfer chain", recipient => {
  const target = EMERGENCY_TARGETS[recipient];
  const events = [event(payer, target.trigger), event(target.trigger, target.pay), event(target.pay, target.wallet)];
  expect(payoutEventsMatch(events, recipient, payer, "50")).toBe(true);
  expect(payoutEventsMatch(events.slice(0, 2), recipient, payer, "50")).toBe(false);
  expect(payoutEventsMatch(events, recipient, payer, "51")).toBe(false);
  const other = Keypair.random().publicKey();
  expect(payoutEventsMatch([...events, event(target.pay, other, 1n)], recipient, payer, "50")).toBe(false);
  expect(payoutEventsMatch([...events.slice(0, 2), event(target.pay, other)], recipient, payer, "50")).toBe(false);
});
