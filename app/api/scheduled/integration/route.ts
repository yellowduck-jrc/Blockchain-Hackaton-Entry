
import { NextResponse } from "next/server";
import {
  ScheduledPaiflowError,
  scheduledCapabilities,
  scheduledFundingDiscovery,
  scheduledState,
  prepareScheduledFunding,
  submitScheduledFunding,
  reconcileScheduledFunding,
} from "@/lib/scheduled-paiflow";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NODE_ID = /^[A-Za-z0-9_-]{1,128}$/;
const ADDRESS = /^G[A-Z2-7]{55}$/;
const CONTRACT = /^C[A-Z2-7]{55}$/;
const UUID =
  /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;

function fail(error: unknown) {
  if (error instanceof ScheduledPaiflowError) {
    return NextResponse.json(
      { error: error.message },
      { status: error.status },
    );
  }

  console.error("Scheduled integration failed:", error);

  return NextResponse.json(
    { error: "Scheduled integration unavailable." },
    { status: 500 },
  );
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ScheduledPaiflowError(
      "Expected a JSON object.",
      400,
    );
  }

  return value as Record<string, unknown>;
}

function fields(
  value: Record<string, unknown>,
  allowed: string[],
  required: string[],
) {
  if (
    Object.keys(value).some((key) => !allowed.includes(key)) ||
    required.some((key) => !(key in value))
  ) {
    throw new ScheduledPaiflowError(
      "Invalid request fields.",
      400,
    );
  }
}

function stringField(
  value: Record<string, unknown>,
  key: string,
  maxLength = 128,
): string {
  const result = value[key];

  if (
    typeof result !== "string" ||
    result.length === 0 ||
    result.length > maxLength
  ) {
    throw new ScheduledPaiflowError(
      `Invalid ${key}.`,
      400,
    );
  }

  return result;
}

export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const read = url.searchParams.get("read");

    if (
      [...url.searchParams.keys()].some(
        (key) => !["read", "nodeId"].includes(key),
      )
    ) {
      throw new ScheduledPaiflowError(
        "Unknown query parameter.",
        400,
      );
    }

    if (read === "capabilities") {
      const result = await scheduledCapabilities();

      if (
        result.network !== "testnet" ||
        result.triggerType !== "schedule"
      ) {
        throw new ScheduledPaiflowError(
          "Expected a Stellar Testnet scheduled deployment.",
          400,
        );
      }

      return NextResponse.json(result);
    }

    if (read === "funding") {
      const result = await scheduledFundingDiscovery();

      if (result.network !== "testnet") {
        throw new ScheduledPaiflowError(
          "Only Testnet funding is supported.",
          400,
        );
      }

      return NextResponse.json(result);
    }

    if (read === "schedule") {
      const nodeId = url.searchParams.get("nodeId");

      if (!nodeId || !NODE_ID.test(nodeId)) {
        throw new ScheduledPaiflowError(
          "Valid nodeId is required.",
          400,
        );
      }

      return NextResponse.json(await scheduledState(nodeId));
    }

    throw new ScheduledPaiflowError(
      "Unsupported read operation.",
      400,
    );
  } catch (error) {
    return fail(error);
  }
}

export async function POST(request: Request) {
  try {
    // Protect wallet-related actions against cross-origin requests.
    if (
      request.headers.get("origin") !==
      new URL(request.url).origin
    ) {
      throw new ScheduledPaiflowError(
        "Cross-origin requests are not allowed.",
        403,
      );
    }

    const raw = await request.json().catch(() => null);
    const body = object(raw);

    fields(
      body,
      ["operation", "phase", "input"],
      ["operation", "phase", "input"],
    );

    if (body.operation !== "funding") {
      throw new ScheduledPaiflowError(
        "Only scheduled funding is supported.",
        400,
      );
    }

    const phase = body.phase;

    if (
      phase !== "prepare" &&
      phase !== "submit" &&
      phase !== "reconcile"
    ) {
      throw new ScheduledPaiflowError(
        "Unsupported funding phase.",
        400,
      );
    }

    const input = object(body.input);

    if (phase === "prepare") {
      fields(
        input,
        [
          "fromAddress",
          "tokenContractAddress",
          "amountStroops",
          "nodeId",
        ],
        [
          "fromAddress",
          "tokenContractAddress",
          "amountStroops",
          "nodeId",
        ],
      );

      const fromAddress = stringField(input, "fromAddress");
      const tokenContractAddress = stringField(
        input,
        "tokenContractAddress",
      );
      const amountStroops = stringField(
        input,
        "amountStroops",
        39,
      );
      const nodeId = stringField(input, "nodeId");

      if (!ADDRESS.test(fromAddress)) {
        throw new ScheduledPaiflowError(
          "Invalid wallet address.",
          400,
        );
      }

      if (!CONTRACT.test(tokenContractAddress)) {
        throw new ScheduledPaiflowError(
          "Invalid token contract address.",
          400,
        );
      }

      if (!NODE_ID.test(nodeId)) {
        throw new ScheduledPaiflowError(
          "Invalid funding node.",
          400,
        );
      }

      if (
        !/^[1-9]\d*$/.test(amountStroops) ||
        BigInt(amountStroops) > (1n << 127n) - 1n
      ) {
        throw new ScheduledPaiflowError(
          "Invalid funding amount.",
          400,
        );
      }

      // Never trust a token contract supplied by the browser.
      const [capabilities, discovery] = await Promise.all([
        scheduledCapabilities(),
        scheduledFundingDiscovery(),
      ]);

      if (
        capabilities.network !== "testnet" ||
        capabilities.triggerType !== "schedule" ||
        capabilities.operations.funding.status === "unsupported" ||
        discovery.network !== "testnet" ||
        discovery.deploymentId !== capabilities.deploymentId
      ) {
        throw new ScheduledPaiflowError(
          "Scheduled funding is unavailable.",
          400,
        );
      }

      const node = discovery.nodes.find(
        (candidate) =>
          candidate.nodeId === nodeId &&
          candidate.action === "schedule.fund" &&
          candidate.tokenContractAddress === tokenContractAddress,
      );

      if (!node) {
        throw new ScheduledPaiflowError(
          "Funding node or token does not match the deployment.",
          400,
        );
      }

      return NextResponse.json(
        await prepareScheduledFunding({
          fromAddress,
          tokenContractAddress,
          amountStroops,
          nodeId,
        }),
      );
    }

    fields(
      input,
      phase === "submit"
        ? ["intent", "signedXdr", "action"]
        : ["intent", "action"],
      phase === "submit"
        ? ["intent", "signedXdr", "action"]
        : ["intent", "action"],
    );

    const intent = stringField(input, "intent");
    const action = stringField(input, "action");

    if (!UUID.test(intent) || action !== "schedule.fund") {
      throw new ScheduledPaiflowError(
        "Invalid funding intent or action.",
        400,
      );
    }

    if (phase === "submit") {
      const signedXdr = stringField(
        input,
        "signedXdr",
        100000,
      );

      return NextResponse.json(
        await submitScheduledFunding({
          intent,
          signedXdr,
          action: "schedule.fund",
        }),
      );
    }

    return NextResponse.json(
      await reconcileScheduledFunding({
        intent,
        action: "schedule.fund",
      }),
    );
  } catch (error) {
    return fail(error);
  }
}
