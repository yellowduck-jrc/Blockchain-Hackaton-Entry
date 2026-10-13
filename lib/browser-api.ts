
"use client";

export class IntegrationError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly requestId: string | null,
    readonly retryAfter: string | null,
    readonly fields?: Record<string, string[]>,
    readonly details?: unknown,
  ) {
    super(
      `${code}: ${message} ${diagnosticNextStep(code, message)}${
        requestId ? ` · x-request-id: ${requestId}` : ""
      }${
        retryAfter ? ` · Retry-After: ${retryAfter}` : ""
      }${
        fields
          ? ` · ${Object.entries(fields)
              .map(
                ([field, errors]) =>
                  `${field}: ${errors.join(", ")}`,
              )
              .join("; ")}`
          : ""
      }`,
    );

    this.name = "IntegrationError";
  }
}

export async function browserRequest<T>(
  path: string,
  body?: unknown,
  headers?: Record<string, string>,
): Promise<T> {
  const response = await fetch(
    path,
    body === undefined
      ? undefined
      : {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...headers,
          },
          body: JSON.stringify(body),
        },
  );

  const requestId = response.headers.get("x-request-id");
  const retryAfter = response.headers.get("Retry-After");

  let value: unknown;

  try {
    value = await response.json();
  } catch {
    throw new IntegrationError(
      "UPSTREAM_RPC",
      "Unresolved response; reconcile the original operation.",
      requestId,
      retryAfter,
    );
  }

  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value)
  ) {
    throw new IntegrationError(
      "UPSTREAM_RPC",
      "The server returned an invalid JSON response.",
      requestId,
      retryAfter,
    );
  }

  const result = value as Record<string, unknown>;

  if (!response.ok || result.error) {
    const error =
      typeof result.error === "object" &&
      result.error !== null
        ? (result.error as Record<string, unknown>)
        : {};

    throw new IntegrationError(
      typeof error.code === "string"
        ? error.code
        : `HTTP ${response.status}`,
      typeof error.message === "string"
        ? error.message
        : "Request failed",
      requestId,
      retryAfter,
      error.fields &&
        typeof error.fields === "object" &&
        !Array.isArray(error.fields)
        ? (error.fields as Record<string, string[]>)
        : undefined,
      error.details,
    );
  }

  // Existing Paiflow endpoints return:
  // { data: { ... } }
  //
  // Scheduled Padala endpoints return:
  // { deploymentId: "...", network: "testnet", ... }
  //
  // Support both formats without breaking existing calls.

  if (
    Object.prototype.hasOwnProperty.call(result, "data")
  ) {
    return result.data as T;
  }

  return result as T;
}

export function retryDelay(error: unknown): number {
  if (
    !(error instanceof IntegrationError) ||
    !error.retryAfter
  ) {
    return 5000;
  }

  const seconds = Number(error.retryAfter);

  const delay = Number.isFinite(seconds)
    ? seconds * 1000
    : Date.parse(error.retryAfter) - Date.now();

  return Number.isFinite(delay)
    ? Math.max(5000, delay)
    : 5000;
}

export function diagnosticNextStep(
  code: string,
  message: string,
): string {
  if (/trustline/i.test(message)) {
    return "Add the recipient's trustline to the exact deployed testnet asset issuer, then check its balance.";
  }

  if (/account.*(missing|exist|funded)/i.test(message)) {
    return "Fund the public account with testnet XLM first; add the exact asset trustline when needed.";
  }

  if (
    ["INSUFFICIENT_FUNDS"].includes(code) ||
    /insufficient|enough.*balance/i.test(message)
  ) {
    return "Check the payer's testnet asset balance and XLM for fees/reserves, plus the flow's pool balance.";
  }

  if (code === "RATE_LIMITED") {
    return "Wait Retry-After before trying the original operation again.";
  }

  if (
    code === "UNAUTHENTICATED" ||
    code === "CONFIGURATION"
  ) {
    return "Check server mode, platform origin, confirmed deployment UUID and its own non-revoked deployment token.";
  }

  if (
    code === "UPSTREAM_RPC" ||
    code === "CONFLICT"
  ) {
    return "Retain the original envelope/intent and reconcile it; do not create a replacement while unresolved.";
  }

  if (code === "FORBIDDEN") {
    return "Verify your app session/ownership permission and the required original controller/subscriber wallet.";
  }

  if (/expired|txTooLate/i.test(message)) {
    return "Reconcile the original operation; only prepare a replacement after platform proof permits it.";
  }

  return "";
}

// Published prepare handlers validate/rate-limit/simulate
// before reserving an intent.
//
// Conflicts may refer to an existing intent.
// Transport errors and 5xx responses are uncertain.

export function preparationDefinitelyRefused(
  error: unknown,
): boolean {
  return (
    error instanceof IntegrationError &&
    [
      "VALIDATION",
      "FORBIDDEN",
      "UNAUTHENTICATED",
      "PREPARATION_MODE",
      "CONFIGURATION",
      "RATE_LIMITED",
      "INSUFFICIENT_FUNDS",
    ].includes(error.code)
  );
}
