import { rpc, xdr, Address, Asset, Networks, scValToNative } from '@stellar/stellar-sdk';
import { writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';

// Read-only verification: no keys, API tokens, simulation, signing or submission.
const server = new rpc.Server('https://soroban-testnet.stellar.org');
const expectedAsset = new Asset('USDC', 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5').contractId(Networks.TESTNET);
const recipients = [
  { recipient: 'parents', deploymentId: '3f61d495-5bfa-4f51-b4e3-f666fc7bf22d', trigger: 'CA4D6A6TV53ESGHWEXV5VMSFGFV4SXSELTDUSYJIA47RU4NNDHGW3INV', wallet: 'GBRHKU2LZNDPRCVXXPFZZ3XNS5DEWGTA4AVCPDER2RHY56EKOQ2EWMJK' },
  { recipient: 'brother', deploymentId: 'd34c35d4-10e0-4b59-9b98-425a1a503023', trigger: 'CDL2M5WIGG7HFH2BFL4XZOWHN3WK7BRYZCH5YFT2N3FBFDE2IJKRW7C4', wallet: 'GAWW3W5X5YETABCWRA4NBIOTX46YGFO5H3NEUHQCORW7PCE7ZYUAPLNB' },
  { recipient: 'sister', deploymentId: '73ebc55f-1a70-4ddd-8172-b05489871c85', trigger: 'CCQIVWQOVORC57J2PPZZ54NECNYKLH76UWSTM5DOGO4GBLEPJ3IM7OS6', wallet: 'GDZJID372SKFUSQAPUWG6NYMIRILIAFI7HZDKAGCF3BI7S6PX7OZFFYX' },
];
async function read(contract) {
  const key = xdr.LedgerKey.contractData(new xdr.LedgerKeyContractData({ contract: new Address(contract).toScAddress(), key: xdr.ScVal.scvLedgerKeyContractInstance(), durability: xdr.ContractDataDurability.persistent }));
  const response = await server.getLedgerEntries(key);
  assert.equal(response.entries.length, 1, 'Contract storage unavailable');
  const instance = response.entries[0].val.contractData.val.instance;
  const fields = {};
  for (const item of instance.storage ?? []) {
    const [name] = scValToNative(item.key);
    fields[name] = scValToNative(item.val);
  }
  return { contract, ledger: response.latestLedger, fields };
}
const checks = [];
for (const target of recipients) {
  // Bind the supplied/discovered trigger to the public deployment trigger page.
  const response = await fetch(`https://beta.app.paiflow.xyz/trigger/${target.deploymentId}`);
  assert(response.ok, 'Public trigger page unavailable');
  const html = await response.text();
  const addresses = [...new Set(html.match(/C[A-Z2-7]{55}/g) ?? [])];
  assert.deepEqual(addresses, [target.trigger], 'Trigger page contract association changed');
  const trigger = await read(target.trigger);
  assert.equal(trigger.fields.Asset, expectedAsset, 'Incorrect trigger asset');
  assert.equal(trigger.fields.Version, 1, 'Unexpected trigger version');
  assert.equal(trigger.fields.NextSteps.length, 1, 'Expected one downstream contract');
  const pay = await read(trigger.fields.NextSteps[0].address);
  assert.equal(pay.fields.Recipient, target.wallet, 'Recipient mismatch');
  assert.equal(pay.fields.Asset, expectedAsset, 'Incorrect Pay asset');
  assert.equal(pay.fields.Amount, 0n, 'Fixed amount must be zero');
  assert.equal(pay.fields.PercentageBps, 10000, 'Must pay 100%');
  assert.equal(pay.fields.ParentNode, target.trigger, 'Pay parent mismatch');
  assert.equal(pay.fields.IsCashOut, false, 'Unexpected cash-out operation');
  assert.deepEqual(pay.fields.NextSteps, [], 'Unexpected downstream payment steps');
  assert.equal(pay.fields.Version, 4, 'Unexpected Pay version');
  checks.push({ ...target, triggerState: trigger, payState: pay, configurationMatches: true });
  console.log(`${target.recipient}: configured recipient, 100% amount, exact Testnet USDC and single downstream Pay verified`);
}
const report = { checkedAt: new Date().toISOString(), network: 'testnet', rpc: 'https://soroban-testnet.stellar.org', expectedAsset, checks, limitation: 'Read-only configuration evidence at the recorded ledgers. No payment sent, no bytecode audit or successful payout proof. Recheck before preparing any future payment.' };
await writeFile(new URL('../docs/emergency-onchain-verification.json', import.meta.url), JSON.stringify(report, (_, value) => typeof value === 'bigint' ? value.toString() : value, 2) + '\n');
