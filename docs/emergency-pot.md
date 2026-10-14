# Emergency Pot: requests, approval and payments

## Local workflow

Use the project's Node 22 runtime and `pnpm.cmd dev`. Refresh the browser after updating the application. Open Emergency Pot and choose Parents, Brother or Younger Sister. Submit the amount and reason. Connect the active Freighter wallet on Testnet and approve the request with its message signature. Exactly one wallet approval is required; Jun is not required.

Open **Review emergency payment**. Check the recipient name, exact USDC amount, recipient public address, deployment ID and paying wallet. Click **Send Emergency Funds**, then review and authorize the transaction in Freighter. The paying wallet must be the same wallet that signed the request approval. Its Testnet USDC balance covers the requested amount, and its XLM balance covers transaction fees. This is a payment from that wallet, not a withdrawal from a shared emergency reserve.

The UI shows Payment Pending while submission/confirmation is unresolved. It marks Paid only after Stellar RPC confirms success and the exact USDC transfers to the selected recipient. A confirmed payment includes a Testnet explorer link and ledger. Approval alone or an HTTP 200 response cannot mark it Paid. Start manual testing with an amount that fits the payer's balance.

## Approval and authorization

Any active wallet may approve or reject, including a recipient wallet. There is no simulated reviewer selector or second reviewer. The SEP-53 message binds the decision to this site's origin, Testnet, request ID, requester, amount, reason and creation time. `/api/emergency/approval` verifies its signature; saved approval evidence is reverified on load and cross-tab updates. Payment preparation, status and submission independently reverify that same signature.

Old v3 simulated reviews reset to Pending while retaining request details. v2 records remain untouched because they lack requester evidence. Request history is browser-local, not a shared family database. The server durably stores the signed request and immutable payment attempt when preparing its payment. The wallet approval is authorization under the requested any-active-wallet policy; no browser status alone is trusted to move funds.

## Deployment routing

| Recipient | Deployment ID | Wallet |
| --- | --- | --- |
| Parents | 3f61d495-5bfa-4f51-b4e3-f666fc7bf22d | GBRHKU2LZNDPRCVXXPFZZ3XNS5DEWGTA4AVCPDER2RHY56EKOQ2EWMJK |
| Brother | d34c35d4-10e0-4b59-9b98-425a1a503023 | GAWW3W5X5YETABCWRA4NBIOTX46YGFO5H3NEUHQCORW7PCE7ZYUAPLNB |
| Sister | 73ebc55f-1a70-4ddd-8172-b05489871c85 | GDZJID372SKFUSQAPUWG6NYMIRILIAFI7HZDKAGCF3BI7S6PX7OZFFYX |

The backend maps the signed requester to server-only credentials and verified contract addresses. Client deployment IDs, payer overrides, recipient addresses and arbitrary upstream paths are not accepted. Jun cannot be an emergency requester. No emergency operation calls Instant Padala's `/api/pay` or global deployment helpers. Instant and Scheduled implementations, family budgets, exchange rates and existing wallet recovery remain intact.

`lib/paiflow.ts` owns every Paiflow API call. Its dedicated emergency client uses only that recipient's configuration and refuses prepare/demo mode. It does not require or fall back to Instant credentials. Deposit preparation uses the documented recipient-specific `execute` endpoint, followed by wallet signing and that deployment's `execute/submit` endpoint. A deployment UUID is not a funding destination, and plain token transfers are not substituted for deposit execution.

Before preparation, live capabilities must match the expected deployment, Testnet, deposit trigger and USDC input. Both deployed contract instances are read from Stellar RPC: pinned bytecode, exact USDC asset, one downstream Pay, intended recipient, 100% payout, zero fixed amount, correct parent and no further steps. Those configuration checks run again before submission.

Prepared XDR must contain one deposit call to the verified trigger, the approved payer and exact amount, no memo or extra operations, bounded fees and expiry, Testnet passphrase and source-account authorization only. The signed envelope must retain the exact transaction hash and contain the payer's valid signature. The UI requires explicit Freighter authorization; approval never starts a payment automatically.

## Confirmation and recovery

Paiflow submission is idempotent by original envelope hash. The app preserves its original signed XDR and never silently creates a second transaction after PENDING, UNKNOWN, timeout, missing history or expired preparation.

The server checks the deployment-specific transaction endpoint and independently queries Stellar RPC. Paid requires a successful original transaction, matching deposit envelope/hash, and exactly these transfers of the full approved USDC amount: payer -> trigger -> Pay -> intended wallet. Missing payout evidence, extra USDC recipients, RPC errors or pruned history remain uncertain. RPC-confirmed failure becomes Failed. Terminal Paid and Failed attempts cannot start another payment for the same request.

After an explicit preparation refusal, such as insufficient funds, a retry may prepare an original transaction because no envelope was issued. After wallet cancellation, **Sign Original Transaction** reuses the stored preparation if it is still valid. **Resubmit Original Transaction** sends only the previously saved signature/envelope. Expired or lost preparations are not replaced without finality evidence; unresolved reservations require operator recovery. Automatic polling confirms status and never signs or sends funds.

## Durable local storage

Payment attempts are stored under `.data/emergency-payments/` in the server's working directory. Request identity is scoped to the browser origin. Exclusive file locks serialize processes, and atomic writes with file sync save the reservation before preparation and exact signed envelope before submission. Immutable recipient, amount, payer and deployment bindings are enforced on every operation. Browser Web Locks serialize tabs, and storage failures stop signing/submission. If local evidence exists but the server record is missing, a replacement is blocked.

**Keep `.data` intact across local server restarts and backups.** It is gitignored and must not be committed or logged. This implementation requires a persistent filesystem shared by the local Node server. An ephemeral/serverless host or independently stored multiple instances requires a shared durable database/transactional lock implementation before deployment. A crash with a held file lock can require operator review; locks never expire automatically. Do not delete payment records to retry uncertain funds.

## Environment and amounts

No new credentials or environment variables are needed. Keep `PAIFLOW_MODE=team`, `PAIFLOW_BASE_URL` and these six assignments in `.env.local`, never NEXT_PUBLIC variables:

| Recipient | Deployment variable | Token variable |
| --- | --- | --- |
| Parents | PAIFLOW_EMERGENCY_POT_PARENT_DEPLOYMENT_ID | PAIFLOW_EMERGENCY_POT_PARENT_API_TOKEN |
| Brother | PAIFLOW_EMERGENCY_POT_BROTHER_DEPLOYMENT_ID | PAIFLOW_EMERGENCY_POT_BROTHER_API_TOKEN |
| Sister | PAIFLOW_EMERGENCY_POT_SISTER_DEPLOYMENT_ID | PAIFLOW_EMERGENCY_POT_SISTER_API_TOKEN |

IDs are checked against the table above and cannot collide with Instant Padala. Tokens never enter public configuration or errors. `.env.local` was not modified. `lib/amount.ts` uses bigint conversion at seven decimal places with a maximum request of 10,000 USDC. PHP estimates use the existing fetched rate only for display.

## Acceptance checklist

- [x] All three requesters, exact amount validation, UUID/time/reason history.
- [x] One active-wallet approval, signature validation and signed rejection.
- [x] Parents' updated deployment mapping and live verification of all three routes.
- [x] Dedicated confirmation, Freighter payment signing and deployment-specific submit.
- [x] Server reservation, immutable attempts, duplicate-click protection and original-XDR recovery.
- [x] Payment Pending, Paid and Failed from server evidence, with explorer/ledger details.
- [x] Independent exact-recipient/amount payout confirmation; API success alone is insufficient.
- [x] Automated cancellation, insufficient-funds refusal, changed wallet, concurrency and uncertain-response coverage.
- [x] Existing regression suite, TypeScript, isolated production build and browser token scan.
- [ ] UNVERIFIED: live Freighter signing and actual transfers to the three recipients, including unrelated-wallet balance checks. No funds were sent during implementation.
- [ ] UNVERIFIED: manual live Instant and Scheduled wallet regression. Existing automated checks pass.
- [ ] OUT OF SCOPE: shared family request database and hosting on ephemeral/distributed infrastructure.

Run `pnpm.cmd exec tsc --noEmit`, `pnpm.cmd build`, then `pnpm.cmd test`. Stop a dev server first or build an isolated source copy to avoid sharing `.next`. Test workers are capped at four to prevent resource-contention timeouts during SDK imports.

[Public Paiflow OpenAPI](https://beta.app.paiflow.xyz/api/v1/openapi.json), [Freighter signing](https://docs.freighter.app/extension-freighter-api/signing), and [SEP-53](https://github.com/stellar/stellar-protocol/blob/master/ecosystem/sep-0053.md) document the API/signing contracts. `docs/emergency-onchain-verification.json` records the original read-only contract evidence. See `docs/emergency-pot-validation.md` for results and `docs/emergency-pot-file-contents.md` for complete delivered sources.
