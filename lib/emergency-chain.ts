import "server-only";
import { Address, Asset, FeeBumpTransaction, Networks, TransactionBuilder, rpc, scValToNative, xdr } from "@stellar/stellar-sdk";
import type { EmergencyRecipient } from "@/lib/emergency";
import { toStroops } from "@/lib/amount";
import type { Prepared } from "@/lib/paiflow";

export const EMERGENCY_TARGETS = {
  parents: { trigger: "CA4D6A6TV53ESGHWEXV5VMSFGFV4SXSELTDUSYJIA47RU4NNDHGW3INV", pay: "CDWHILTEQ5KMONWZ3XQML3ISFBLSYMF65GRYPQT2T67BU32QBKBJJXKO", wallet: "GBRHKU2LZNDPRCVXXPFZZ3XNS5DEWGTA4AVCPDER2RHY56EKOQ2EWMJK" },
  brother: { trigger: "CDL2M5WIGG7HFH2BFL4XZOWHN3WK7BRYZCH5YFT2N3FBFDE2IJKRW7C4", pay: "CA6NKUJGJG4YQEVPN6NTXXEN7MO42L5OA4A2JVCYNOMMGFP66G2EIS2H", wallet: "GAWW3W5X5YETABCWRA4NBIOTX46YGFO5H3NEUHQCORW7PCE7ZYUAPLNB" },
  sister: { trigger: "CCQIVWQOVORC57J2PPZZ54NECNYKLH76UWSTM5DOGO4GBLEPJ3IM7OS6", pay: "CDHOU6GFDTFIBADEKF4FEKSGZOT2HTLKMOH5OTYK2SROCH73VN5FKXGE", wallet: "GDZJID372SKFUSQAPUWG6NYMIRILIAFI7HZDKAGCF3BI7S6PX7OZFFYX" },
} satisfies Record<EmergencyRecipient, { trigger: string; pay: string; wallet: string }>;
const TRIGGER_WASM = "472061679c6b6fc313f70107c09ed7ca3d21ccd0aef15b082c2533632ee75602";
const PAY_WASM = "b331db1c3e26da4fe8aec7635a567a11fb5e069123c355eaae92d095d5ef457f";
export const EMERGENCY_USDC = new Asset("USDC", "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5").contractId(Networks.TESTNET);
export const emergencyRpc = new rpc.Server("https://soroban-testnet.stellar.org", { timeout: 20000 });
function requireMatch(condition: unknown, message: string): asserts condition { if (!condition) throw new Error(message); }
async function instance(contract: string, wasm: string) {
  const key = xdr.LedgerKey.contractData(new xdr.LedgerKeyContractData({ contract: new Address(contract).toScAddress(), key: xdr.ScVal.scvLedgerKeyContractInstance(), durability: xdr.ContractDataDurability.persistent }));
  const response = await emergencyRpc.getLedgerEntries(key);
  const entry = response.entries[0];
  requireMatch(entry?.val.type === "contractData" && entry.val.contractData.val.type === "scvContractInstance", "Contract configuration unavailable.");
  const state = entry.val.contractData.val.instance;
  requireMatch(state.executable.type === "contractExecutableWasm" && Buffer.from(state.executable.wasmHash.value).toString("hex") === wasm, "Deployed contract code changed; review required.");
  const fields: Record<string, unknown> = {};
  for (const pair of state.storage ?? []) { const [name] = scValToNative(pair.key) as string[]; if (name) fields[name] = scValToNative(pair.val); }
  return fields;
}
export async function verifyEmergencyTarget(recipient: EmergencyRecipient) {
  const target = EMERGENCY_TARGETS[recipient];
  const [trigger, pay] = await Promise.all([instance(target.trigger, TRIGGER_WASM), instance(target.pay, PAY_WASM)]);
  const steps = trigger.NextSteps as { address: string; data: string }[] | undefined;
  requireMatch(trigger.Version === 1 && trigger.Asset === EMERGENCY_USDC && Array.isArray(steps) && steps.length === 1 && steps[0]?.address === target.pay && steps[0]?.data === "", "Emergency trigger topology or asset changed.");
  requireMatch(pay.Version === 4 && pay.Asset === EMERGENCY_USDC && pay.Recipient === target.wallet && pay.Amount === 0n && pay.PercentageBps === 10000 && pay.IsCashOut === false && pay.ParentNode === target.trigger && Array.isArray(pay.NextSteps) && pay.NextSteps.length === 0, "Emergency Pay recipient or full-amount configuration changed.");
  return target;
}
export function validateEmergencyEnvelope(xdrText: string, recipient: EmergencyRecipient, payer: string, amount: string) {
  const tx = TransactionBuilder.fromXDR(xdrText, Networks.TESTNET);
  requireMatch(!(tx instanceof FeeBumpTransaction) && tx.source === payer && tx.operations.length === 1 && tx.memo.type === "none", "Wrong payment source or envelope operations.");
  const op = tx.operations[0];
  requireMatch(op?.type === "invokeHostFunction" && (!op.source || op.source === payer) && op.func.type === "hostFunctionTypeInvokeContract", "Expected one deposit invocation.");
  const call = op.func.invokeContract;
  requireMatch(Address.fromScAddress(call.contractAddress).toString() === EMERGENCY_TARGETS[recipient].trigger && call.functionName.toString() === "deposit" && call.args.length === 2 && scValToNative(call.args[0]!) === payer && scValToNative(call.args[1]!) === BigInt(toStroops(amount)), "Prepared payment does not match the approved emergency request.");
  requireMatch((op.auth ?? []).every(entry => entry.credentials.type === "sorobanCredentialsSourceAccount"), "Unexpected independent authorization entries.");
  requireMatch(BigInt(tx.fee) <= 100000000n && !!tx.timeBounds && BigInt(tx.timeBounds.maxTime) > 0n, "Unexpected fee or unbounded payment lifetime.");
  return tx;
}
export function validateEmergencyPreparation(prepared: Prepared, recipient: EmergencyRecipient, payer: string, amount: string) {
  requireMatch(prepared.network === "testnet" && prepared.networkPassphrase === Networks.TESTNET, "Only Testnet payments are allowed.");
  const tx = validateEmergencyEnvelope(prepared.xdr, recipient, payer, amount);
  const expires = Date.parse(prepared.expiresAt);
  requireMatch(Number.isFinite(expires) && expires > Date.now() && Math.abs(expires - Number(tx.timeBounds!.maxTime) * 1000) <= 1000 && expires <= Date.now() + 10 * 60 * 1000 && tx.signatures.length === 0, "Invalid payment expiry or pre-signed preparation.");
  return { xdr: prepared.xdr, network: "testnet" as const, networkPassphrase: Networks.TESTNET, expiresAt: new Date(expires).toISOString(), txHash: Buffer.from(tx.hash()).toString("hex"), ...(prepared.preparationRequestId && /^[a-f0-9-]{36}$/i.test(prepared.preparationRequestId) ? { preparationRequestId: prepared.preparationRequestId } : {}) };
}
export function payoutEventsMatch(events: xdr.ContractEvent[], recipient: EmergencyRecipient, payer: string, amount: string): boolean {
  const target = EMERGENCY_TARGETS[recipient];
  const transfers: string[] = [];
  for (const event of events) {
    if (!event.contractId || Address.fromScAddress(xdr.ScAddress.scAddressTypeContract(event.contractId)).toString() !== EMERGENCY_USDC || event.body.type !== "v0") continue;
    const topics = event.body.v0.topics.map(scValToNative);
    if (topics[0] === "transfer") transfers.push(JSON.stringify([topics[1], topics[2], String(scValToNative(event.body.v0.data))]));
  }
  const stroops = toStroops(amount);
  const expected = [[payer, target.trigger, stroops], [target.trigger, target.pay, stroops], [target.pay, target.wallet, stroops]].map(value => JSON.stringify(value)).sort();
  return JSON.stringify(transfers.sort()) === JSON.stringify(expected);
}
export async function confirmedEmergencyPayment(txHash: string, recipient: EmergencyRecipient, payer: string, amount: string) {
  const result = await emergencyRpc.getTransaction(txHash);
  if (result.status === "NOT_FOUND") return { status: "UNKNOWN" as const };
  requireMatch(result.txHash === txHash && !result.feeBump, "Transaction confirmation mismatch.");
  if (result.status === "FAILED") return { status: "FAILED" as const, ledger: result.ledger };
  const tx = TransactionBuilder.fromXDR(result.envelopeXdr, Networks.TESTNET);
  requireMatch(Buffer.from(tx.hash()).toString("hex") === txHash, "Confirmed transaction hash mismatch.");
  validateEmergencyEnvelope(tx.toXDR(), recipient, payer, amount);
  if (!payoutEventsMatch(result.events.contractEventsXdr.flat(), recipient, payer, amount)) return { status: "UNKNOWN" as const };
  return { status: "SUCCESS" as const, ledger: result.ledger };
}
