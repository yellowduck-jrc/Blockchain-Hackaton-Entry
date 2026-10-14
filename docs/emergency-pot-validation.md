# Emergency payments validation ? 2026-10-14

- PASS: `pnpm.cmd exec tsc --noEmit` on final implementation.
- PASS: `pnpm.cmd test` ? 16 files, 192 tests, zero failures.
- PASS: production build in an isolated temporary source copy, using existing installed dependencies. The running dev server was not stopped; `.env.local` was not copied.
- PASS: isolated browser bundle scan ? 28 files, no Paiflow API token matches.
- PASS: read-only GET `http://localhost:3000/api/emergency/integration` ? all three configured deployments returned paymentEnabled=true after actual Paiflow capabilities and live pinned contract verification. No prepare or submit was called.
- PASS: read-only Stellar RPC check of an existing public Testnet USDC transaction confirmed the successful-transaction response exposes committed contractEventsXdr used by the payout verifier. This was not an emergency payment test.

New tests cover each recipient's own credentials/UUID independently of Instant configuration; exact amount/deposit binding; extra-recipient/missing/wrong-amount payout events; same-origin and verified wallet approval; immutable request fields; concurrent server preparation; reservation durability before upstream calls; uncertain preparation/submission; original signed envelope retention/resubmission; confirmed Paid/Failed terminal states; insufficient-funds refusal; wallet cancellation/change; duplicate UI clicks; and missing durable server evidence.

An unrestricted parallel regression run hit an existing page test's five-second cold-import deadline under SDK worker contention. Vitest now caps workers at four; the full standard test command passes without weakening assertions or increasing timeouts.

The available runtime is Node 24.21.0, while the declared project engine is Node 22. Use Node 22 locally to match the project requirement.

No wallet was opened or signed by the agent, and no funds were sent. Actual Freighter authorizations and live recipient payouts remain manual acceptance work. Durable payment storage is local `.data/emergency-payments`, not a production shared database; preserve it across restarts and do not use an ephemeral host.
