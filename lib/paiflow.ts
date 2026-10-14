import "server-only";
import { emergencyConfiguration } from "@/lib/emergency-paiflow";
import type { EmergencyRecipient } from "@/lib/emergency";
import {
  FeeBumpTransaction,
  Networks,
  TransactionBuilder,
} from "@stellar/stellar-sdk";
// starter code, not a supported package — edit freely.

export type Prepared = {
  xdr: string;
  networkPassphrase: string;
  network: "testnet" | "mainnet";
  expiresAt: string;
  preparationRequestId?: string;
  txHash?: string;
};
export type Submitted = {
  txHash: string;
  status: "SUCCESS" | "PENDING" | "FAILED";
  ledger?: number;
  error?: { code: string; message: string };
};
export type ApiFailure = {
  code: string;
  message: string;
  fields?: Record<string, string[]>;
  details?: unknown;
};
export class PaiflowError extends Error {
  constructor(
    readonly status: number,
    readonly api: ApiFailure,
    readonly retryAfter: string | null,
    readonly requestId: string | null,
  ) {
    super(api.message);
  }
}
type Config = { origin: string; deploymentId: string; token: string };
export type Mode = "prepare" | "demo" | "team";
export type PublicConfig =
  | { mode: "prepare" | "demo"; deploymentUrl: null }
  | { mode: "team"; deploymentUrl: string }
  | { mode: "disabled"; deploymentUrl: null; message: string };

function configurationError(message: string): never {
  throw new PaiflowError(503, { code: "CONFIGURATION", message }, null, null);
}
function mode(): Mode {
  const value = process.env.PAIFLOW_MODE?.trim() ?? "prepare";
  if (value === "prepare" || value === "demo" || value === "team") return value;
  return configurationError("Set PAIFLOW_MODE to prepare, demo or team.");
}
function origin() {
  try {
    const url = new URL(
      process.env.PAIFLOW_BASE_URL || "https://beta.app.paiflow.xyz",
    );
    if (
      !["http:", "https:"].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      url.pathname !== "/"
    )
      return configurationError("Set PAIFLOW_BASE_URL to a platform origin.");
    return url.origin;
  } catch {
    return configurationError("Set PAIFLOW_BASE_URL to a platform origin.");
  }
}
function teamConfig(): Config {
  const token = process.env.PAIFLOW_API_TOKEN?.trim();
  const deploymentId = process.env.PAIFLOW_DEPLOYMENT_ID?.trim();
  if (!token || !deploymentId)
    return configurationError(
      "Team mode requires PAIFLOW_API_TOKEN and PAIFLOW_DEPLOYMENT_ID.",
    );
  if (!/^pfk_[a-f0-9]{64}$/.test(token))
    return configurationError(
      "Set a valid deployment API token for team mode.",
    );
  if (
    !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(
      deploymentId,
    )
  )
    return configurationError("Set a valid deployment UUID for team mode.");
  return { origin: origin(), deploymentId, token };
}
export function requireIntegration(): "demo" | "team" {
  const selected = mode();
  switch (selected) {
    case "prepare":
      throw new PaiflowError(
        403,
        {
          code: "PREPARATION_MODE",
          message:
            "Payments and the live feed are disabled in preparation mode.",
        },
        null,
        null,
      );
    case "demo":
      origin();
      return selected;
    case "team":
      teamConfig();
      return selected;
    default: {
      const unreachable: never = selected;
      return unreachable;
    }
  }
}
type Demo = Config & { expires: number };
type DemoCache = { demo?: Demo; minting?: Promise<Demo> };
// Next builds separate route bundles. Share the cache across those bundles and dev reloads.
const processState = globalThis as typeof globalThis & {
  __paiflowDemoCache?: Map<string, DemoCache>;
};
const demoCaches = (processState.__paiflowDemoCache ??= new Map<
  string,
  DemoCache
>());
export function publicConfig(): PublicConfig {
  try {
    const selected = mode();
    switch (selected) {
      case "prepare":
        return { mode: selected, deploymentUrl: null };
      case "demo":
        origin();
        return { mode: selected, deploymentUrl: null };
      case "team": {
        const config = teamConfig();
        return {
          mode: selected,
          deploymentUrl: new URL(
            `/deployments/${config.deploymentId}`,
            config.origin,
          ).href,
        };
      }
      default: {
        const unreachable: never = selected;
        return unreachable;
      }
    }
  } catch (error) {
    if (error instanceof PaiflowError && error.api.code === "CONFIGURATION")
      return { mode: "disabled", deploymentUrl: null, message: error.message };
    throw error;
  }
}
async function config(): Promise<Config> {
  if (requireIntegration() === "team") return teamConfig();
  const platformOrigin = origin();
  const cache = demoCaches.get(platformOrigin) ?? {};
  demoCaches.set(platformOrigin, cache);
  if (cache.demo && Date.now() < cache.demo.expires - 120_000)
    return cache.demo;
  // Single flight: concurrent requests must not consume the 3/hour token allowance.
  if (!cache.minting)
    cache.minting = getDemoToken(platformOrigin)
      .then((value) => {
        const expires = Date.parse(value.expiresAt);
        if (!Number.isFinite(expires) || expires <= Date.now() + 120_000)
          throw new Error("Demo token validity is too short.");
        cache.demo = {
          origin: platformOrigin,
          token: value.token,
          deploymentId: value.deploymentId,
          expires,
        };
        return cache.demo;
      })
      .finally(() => {
        cache.minting = undefined;
      });
  return cache.minting;
}
async function call<T>(
  endpoint: string,
  method: "GET" | "POST",
  body?: unknown,
  query?: URLSearchParams,
  publicPath?: string,
  extraHeaders?: Record<string, string>,
  deploymentConfig?: Config,
): Promise<T> {
  const { origin, deploymentId, token } = deploymentConfig ?? await config();
  const url = new URL(
    publicPath
      ? `api/deployments/${deploymentId}/${publicPath}`
      : ["api", "v1", "deployments", deploymentId, endpoint].join("/"),
    origin + "/",
  );
  if (query) url.search = query.toString();
  const response = await fetch(url, {
    method,
    ...(deploymentConfig ? { signal: AbortSignal.timeout(20000), cache: "no-store" as const } : {}),
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      ...extraHeaders,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const requestId = response.headers.get("x-request-id");
  const unexpected = `Unexpected Paiflow HTTP ${response.status}${requestId ? ` (x-request-id: ${requestId})` : ""}`;
  let result: { data: T } | { error: ApiFailure };
  try {
    result = await response.json();
  } catch {
    throw new PaiflowError(
      response.ok ? 502 : response.status,
      { code: "UPSTREAM_RPC", message: unexpected },
      response.headers.get("Retry-After"),
      requestId,
    );
  }
  if ("error" in result) {
    throw new PaiflowError(
      response.status,
      result.error,
      response.headers.get("Retry-After"),
      requestId,
    );
  }
  if (!response.ok)
    throw new PaiflowError(
      response.ok ? 502 : response.status,
      { code: "UPSTREAM_RPC", message: unexpected },
      response.headers.get("Retry-After"),
      requestId,
    );
  if (
    endpoint === "execute" &&
    response.headers.get("x-history-request-id") &&
    result.data &&
    typeof result.data === "object"
  ) {
    return {
      ...result.data,
      preparationRequestId: response.headers.get("x-history-request-id")!,
    };
  }
  return result.data;
}
// Only expose a boolean to the client; the token and raw capability response stay server-side.
export async function payoutsAvailable(): Promise<boolean> {
  if (requireIntegration() !== "team") return false;
  const capabilities = await call<{
    network?: string;
    operations?: { payouts?: { status?: string } };
  }>("capabilities", "GET");
  const status = capabilities?.operations?.payouts?.status;
  return (
    capabilities?.network === "testnet" &&
    (status === "supported" || status === "conditional")
  );
}

export function executeHash(xdr: string): string {
  try {
    const transaction = TransactionBuilder.fromXDR(xdr, Networks.TESTNET);
    if (transaction instanceof FeeBumpTransaction)
      throw new Error("Unsupported envelope");
    return Buffer.from(transaction.hash()).toString("hex");
  } catch {
    throw new PaiflowError(
      422,
      {
        code: "VALIDATION",
        message:
          "Invalid original transaction envelope; retain recovery evidence for support.",
      },
      null,
      null,
    );
  }
}
export const prepareExecute = async (input: {
  from: string;
  amount: string;
}) => {
  const prepared = await call<Prepared>("execute", "POST", input);
  if (
    prepared.network !== "testnet" ||
    prepared.networkPassphrase !== Networks.TESTNET
  )
    throw new PaiflowError(
      422,
      { code: "VALIDATION", message: "Only Testnet preparations are allowed." },
      null,
      null,
    );
  return { ...prepared, txHash: executeHash(prepared.xdr) };
};
/** Recover old records from their original envelope, never from a replacement. */
export async function reconcileExecute(xdr: string) {
  const txHash = executeHash(xdr);
  try {
    return { ...(await transactionStatus(txHash)), txHash };
  } catch (error) {
    // Absent deployment association / RPC history is uncertainty, not expiry proof.
    if (
      error instanceof PaiflowError &&
      error.status === 404 &&
      error.api.code === "NOT_FOUND"
    )
      return { status: "UNKNOWN", txHash };
    throw error;
  }
}
export const submitExecute = (
  input: { signedXdr: string },
  wait = true,
  preparationRequestId?: string,
) =>
  call<Submitted>(
    "execute/submit",
    "POST",
    input,
    new URLSearchParams({ wait: String(wait) }),
    undefined,
    preparationRequestId
      ? { "x-preparation-request-id": preparationRequestId }
      : undefined,
  );

export type EventItem = {
  id: string;
  eventId: string;
  kind: string;
  topic: string | null;
  ledger: number;
  txHash: string;
  occurredAt: string;
  data: unknown;
};
export type EventPage = {
  items: EventItem[];
  nextCursor: string | null;
  hasMore: boolean;
};
export function listEvents(
  input: { cursor?: string; limit?: number; txHash?: string } = {},
) {
  const query = new URLSearchParams();
  if (input.cursor) query.set("cursor", input.cursor);
  if (input.limit !== undefined) query.set("limit", String(input.limit));
  if (input.txHash) query.set("txHash", input.txHash);
  return call<EventPage>("events", "GET", undefined, query);
}

// One page at a time in your server polling handler:
// const page = await listEvents({ cursor: savedCursor ?? undefined });
// savedCursor = page.nextCursor;
// return page; // browser drains hasMore, then waits before asking again

export const preparePayout = (input: {
  from: string;
  amount: string;
  recipient: string;
  nodeId?: string;
}) => call<Prepared & { nodeId: string }>("payouts", "POST", input);
export const submitPayout = (input: { signedXdr: string }, wait = true) =>
  call<Submitted>(
    "payouts/submit",
    "POST",
    input,
    new URLSearchParams({ wait: String(wait) }),
  );

// Catch PaiflowError in your server handler. For status 409/429, forward status
// and Retry-After to your UI; wait that many seconds before retrying.
// Keep a submitted envelope to retry submitPayout while outcome is uncertain.

export const releaseEarly = (input: { nodeId?: string } = {}) =>
  call<{ nodeId: string; txHash: string; ledger?: number }>(
    "release-early",
    "POST",
    input,
  );
// Teams must add their own authorisation before exposing releaseEarly in a server route.
// The integration adapter requires explicit application authorization.

export async function getOpenApi(origin: string): Promise<unknown> {
  requireIntegration();
  const response = await fetch(new URL("/api/v1/openapi.json", origin));
  if (!response.ok) throw new Error(`OpenAPI HTTP ${response.status}`);
  return response.json();
}
export async function getDemoToken(origin: string) {
  if (requireIntegration() !== "demo")
    throw new PaiflowError(
      403,
      { code: "FORBIDDEN", message: "Demo access requires PAIFLOW_MODE=demo." },
      null,
      null,
    );
  const response = await fetch(new URL("/api/v1/demo-token", origin), {
    method: "POST",
  });
  const body = (await response.json()) as
    | { data: { deploymentId: string; token: string; expiresAt: string } }
    | { error: ApiFailure };
  if ("error" in body)
    throw new PaiflowError(
      response.status,
      body.error,
      response.headers.get("Retry-After"),
      response.headers.get("x-request-id"),
    );
  if (!response.ok) throw new Error(`Demo HTTP ${response.status}`);
  return body.data; // keep token server-side
}

export type {
  DeploymentCapabilities,
  FundingDiscovery,
  ScheduleState,
  SubscriptionState,
} from "@/lib/api-types";
import type {
  DeploymentCapabilities,
  FundingDiscovery,
  FundingPrepare,
  FundingPrepared,
  FundingSubmit,
  FundingReconcile,
  FundingReconciled,
  ScheduleState,
  SchedulePrepared,
  ScheduleReconciled,
  SubscriptionState,
  SubscriptionControlPrepared,
  SubscriptionControlReconciled,
  TransactionStatus,
  DeploymentBalances,
  SwapQuote,
} from "@/lib/api-types";
export const capabilities = () =>
  call<DeploymentCapabilities>("capabilities", "GET");
export const balances = () => call<DeploymentBalances>("balances", "GET");
export const transactionStatus = (txHash: string) =>
  call<TransactionStatus>(`transactions/${encodeURIComponent(txHash)}`, "GET");
export const swapQuote = (input: { amount: string; nodeId?: string }) =>
  call<SwapQuote>(
    "swap-quote",
    "GET",
    undefined,
    new URLSearchParams({
      amountStroops: input.amount,
      ...(input.nodeId ? { nodeId: input.nodeId } : {}),
    }),
  );
export const fundingDiscovery = () => call<FundingDiscovery>("funding", "GET");
export const prepareFunding = (input: FundingPrepare) =>
  call<FundingPrepared>("funding", "POST", input);
export const submitFunding = (input: FundingSubmit) =>
  call<TransactionStatus>("funding/submit", "POST", input);
export const reconcileFunding = (input: FundingReconcile) =>
  call<FundingReconciled>("funding/reconcile", "POST", input);
export const scheduleState = (nodeId?: string) =>
  call<ScheduleState>(
    "schedule/state",
    "GET",
    undefined,
    nodeId ? new URLSearchParams({ nodeId }) : undefined,
  );
export type ScheduleAction = "pause" | "resume" | "retrieve";
export const prepareSchedule = (
  action: ScheduleAction,
  input: { walletAddress: string; nodeId?: string },
) => call<SchedulePrepared>(`schedule/${action}`, "POST", input);
export const submitSchedule = (
  action: ScheduleAction,
  input: { intent: string; signedXdr: string },
) => call<TransactionStatus>(`schedule/${action}/submit`, "POST", input);
export const reconcileSchedule = (
  action: ScheduleAction,
  input: { intent: string },
) => call<ScheduleReconciled>(`schedule/${action}/reconcile`, "POST", input);
export const subscriptionState = () =>
  call<SubscriptionState>("subscription/state", "GET");
export type SubscriptionAction = "cancel" | "reactivate";
export const prepareSubscription = (
  action: SubscriptionAction,
  input: { walletAddress: string },
) =>
  call<SubscriptionControlPrepared>(
    `subscription/${action}/prepare`,
    "POST",
    input,
  );
export const submitSubscription = (
  action: SubscriptionAction,
  input: { intent: string; signedXdr: string },
) => call<TransactionStatus>(`subscription/${action}/submit`, "POST", input);
export const reconcileSubscription = (
  action: SubscriptionAction,
  input: { intent: string },
) =>
  call<SubscriptionControlReconciled>(
    `subscription/${action}/reconcile`,
    "POST",
    input,
  );
export async function prepareAllowance(input: {
  userAddress: string;
  amount: string;
}) {
  const state = await subscriptionState();
  if (state.network !== "testnet")
    configurationError("Only Testnet approvals are allowed.");
  const p = await call<{
    xdr: string;
    intent: string;
    txHash: string;
    networkPassphrase: string;
  }>("", "POST", input, undefined, "subscription-allowance");
  // Public approval response omits expiry/network. Its platform-signed intent
  // embeds the transaction maxTime; platform validates the MAC on submit/status.
  const metadata: unknown = JSON.parse(
    Buffer.from(p.intent.split(".")[0] ?? "", "base64url").toString("utf8"),
  );
  if (
    !metadata ||
    typeof metadata !== "object" ||
    !("maxTime" in metadata) ||
    typeof metadata.maxTime !== "string" ||
    !/^[1-9]\d{0,12}$/.test(metadata.maxTime)
  )
    configurationError(
      "Approval expiry metadata is unavailable; contact platform support.",
    );
  return {
    ...p,
    network: state.network,
    expiresAt: new Date(Number(metadata.maxTime) * 1000).toISOString(),
  };
}
export const submitAllowance = (input: { intent: string; signedXdr: string }) =>
  call<TransactionStatus>(
    "",
    "POST",
    input,
    undefined,
    "subscription-allowance/submit",
  );
export const allowanceStatus = (intent: string) =>
  call<TransactionStatus>(
    "",
    "GET",
    undefined,
    new URLSearchParams({ intent }),
    "subscription-allowance/status",
  );

export type WebhookReward = {
  key: string;
  payload: { escrow: true; amount?: string };
};
// Save this record in your database against the logical completed event BEFORE
// calling. Load it unchanged on retry. Never generate a new key after uncertainty.
export async function webhookReward(record: WebhookReward) {
  if (requireIntegration() !== "team")
    configurationError("Webhook rewards require team mode.");
  if (
    !/^[A-Za-z0-9._:-]{1,128}$/.test(record.key) ||
    record.payload.escrow !== true ||
    (record.payload.amount !== undefined &&
      (!/^(0|[1-9]\d{0,38})$/.test(record.payload.amount) ||
        BigInt(record.payload.amount) > (1n << 127n) - 1n))
  )
    configurationError("Invalid stable Webhook reward record.");
  const secret = process.env.PAIFLOW_WEBHOOK_SECRET;
  if (!secret)
    configurationError("Configure server-only PAIFLOW_WEBHOOK_SECRET.");
  const c = teamConfig();
  if ((await capabilities()).network !== "testnet")
    configurationError("Only Testnet callbacks are allowed.");
  const response = await fetch(
    new URL(`/api/webhooks/${c.deploymentId}`, c.origin),
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-webhook-secret": secret,
        "Idempotency-Key": record.key,
      },
      body: JSON.stringify(record.payload),
    },
  );
  const result = await response.json();
  if (!response.ok)
    throw new PaiflowError(
      response.status,
      result.error ?? {
        code: "UPSTREAM_RPC",
        message:
          "Callback outcome unresolved; retry the saved key and payload.",
      },
      response.headers.get("Retry-After"),
      response.headers.get("x-request-id"),
    );
  return result.data as {
    attemptId: string;
    network: string;
    status: string;
    txHash?: string;
  };
}

export function integrationOrigin() {
  requireIntegration();
  return origin();
}

// Dedicated emergency client. Every call is bound to the server recipient mapping;
// no demo/global Instant deployment fallback and no client-supplied upstream path.
export function emergencyPaiflow(recipient: EmergencyRecipient) {
  if (mode() !== "team") configurationError("Emergency payments require team mode.");
  const selected = { ...emergencyConfiguration(recipient), origin: origin() };
  return {
    capabilities: () => call<DeploymentCapabilities>("capabilities", "GET", undefined, undefined, undefined, undefined, selected),
    prepare: (from: string, amount: string) => call<Prepared>("execute", "POST", { from, amount }, undefined, undefined, undefined, selected),
    submit: (signedXdr: string, preparationRequestId?: string) => call<Submitted>("execute/submit", "POST", { signedXdr }, new URLSearchParams({ wait: "false" }), undefined, preparationRequestId ? { "x-preparation-request-id": preparationRequestId } : undefined, selected),
    status: (txHash: string) => call<TransactionStatus>(`transactions/${encodeURIComponent(txHash)}`, "GET", undefined, undefined, undefined, undefined, selected),
  };
}
