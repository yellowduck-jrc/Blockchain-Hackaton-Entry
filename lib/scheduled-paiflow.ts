
import "server-only";

const TESTNET_PASSPHRASE = "Test SDF Network ; September 2015";

export class ScheduledPaiflowError extends Error {
  constructor(
    message: string,
    public readonly status: number,
  ) {
    super(message);
    this.name = "ScheduledPaiflowError";
  }
}

function getConfig() {
  const baseUrl = process.env.PAIFLOW_BASE_URL;
  const deploymentId = process.env.PAIFLOW_SCHEDULED_DEPLOYMENT_ID;
  const token = process.env.PAIFLOW_SCHEDULED_API_TOKEN;

  if (!baseUrl || !deploymentId || !token) {
    throw new ScheduledPaiflowError(
      "Scheduled Paiflow configuration is missing.",
      503,
    );
  }

  if (!baseUrl.startsWith("https://")) {
    throw new ScheduledPaiflowError(
      "Scheduled Paiflow requires an HTTPS API URL.",
      503,
    );
  }

  return { baseUrl, deploymentId, token };
}

async function request<T>(
  path: string,
  method: "GET" | "POST" = "GET",
  body?: Record<string, unknown>,
): Promise<T> {
  const { baseUrl, deploymentId, token } = getConfig();

  const url = new URL(
    `/api/v1/deployments/${deploymentId}${path}`,
    baseUrl,
  );

  let response: Response;

  try {
    response = await fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
      cache: "no-store",
      signal: AbortSignal.timeout(20000),
    });
  } catch {
    throw new ScheduledPaiflowError(
      "Unable to reach the Paiflow API.",
      502,
    );
  }

  const result: unknown = await response.json().catch(() => null);

  if (!response.ok) {
    const data =
      result && typeof result === "object"
        ? (result as Record<string, unknown>)
        : {};

    const error =
      data.error && typeof data.error === "object"
        ? (data.error as Record<string, unknown>)
        : {};

    throw new ScheduledPaiflowError(
      typeof error.message === "string"
        ? error.message
        : "Scheduled Paiflow request failed.",
      response.status,
    );
  }

  // The hosted API returns its payload inside { data: ... }.
  if (
    !result ||
    typeof result !== "object" ||
    !("data" in result)
  ) {
    throw new ScheduledPaiflowError(
      "Unexpected response from Paiflow.",
      502,
    );
  }

  return (result as { data: T }).data;
}

export async function scheduledCapabilities() {
  return request<import("@/lib/api-types").DeploymentCapabilities>(
    "/capabilities",
  );
}

export async function scheduledFundingDiscovery() {
  return request<import("@/lib/api-types").FundingDiscovery>(
    "/funding",
  );
}

export async function scheduledState(nodeId: string) {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(nodeId)) {
    throw new ScheduledPaiflowError("Invalid node ID.", 400);
  }

  return request<import("@/lib/api-types").ScheduleState>(
    `/schedule/state?nodeId=${encodeURIComponent(nodeId)}`,
  );
}

export async function prepareScheduledFunding(input: {
  fromAddress: string;
  tokenContractAddress: string;
  amountStroops: string;
  nodeId: string;
}) {
  const prepared = await request<
    import("@/lib/api-types").FundingPrepared
  >("/funding", "POST", input);

  if (prepared.network !== "testnet") {
    throw new ScheduledPaiflowError(
      "Only Stellar Testnet transactions are allowed.",
      400,
    );
  }

  return {
    ...prepared,
    networkPassphrase: TESTNET_PASSPHRASE,
  };
}

export async function submitScheduledFunding(input: {
  intent: string;
  signedXdr: string;
  action: "schedule.fund";
}) {
  return request<{
    status: string;
    txHash: string;
  }>("/funding/submit", "POST", input);
}

export async function reconcileScheduledFunding(input: {
  intent: string;
  action: "schedule.fund";
}) {
  return request<import("@/lib/api-types").FundingReconciled>(
    "/funding/reconcile",
    "POST",
    input,
  );
}
