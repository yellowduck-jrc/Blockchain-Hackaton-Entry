
import { NextResponse } from "next/server";

export async function GET() {
  const deploymentId =
    process.env.PAIFLOW_SCHEDULED_DEPLOYMENT_ID;

  const token =
    process.env.PAIFLOW_SCHEDULED_API_TOKEN;

  const baseUrl =
    process.env.PAIFLOW_BASE_URL;

  if (!deploymentId || !token || !baseUrl) {
    return NextResponse.json(
      { error: "Scheduled Paiflow configuration is missing." },
      { status: 503 }
    );
  }

  try {
    const url = new URL(
      `/api/v1/deployments/${deploymentId}/funding`,
      baseUrl
    );

    const response = await fetch(url, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${token}`,
      },
      cache: "no-store",
    });

    const result = await response.json();

    if (!response.ok) {
      return NextResponse.json(
        {
          error: "Funding discovery failed.",
          details: result.error?.message ?? "Unknown error",
        },
        { status: response.status }
      );
    }

    return NextResponse.json(result);
  } catch {
    return NextResponse.json(
      { error: "Unable to connect to Paiflow." },
      { status: 502 }
    );
  }
}
