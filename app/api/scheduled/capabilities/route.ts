
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
      { error: "Scheduled flow configuration is missing." },
      { status: 503 }
    );
  }

  try {
    const response = await fetch(
      `${baseUrl}/api/v1/deployments/${deploymentId}/capabilities`,
      {
        headers: {
          Authorization: `Bearer ${token}`,
        },
        cache: "no-store",
      }
    );

    if (!response.ok) {
      return NextResponse.json(
        { error: "Unable to retrieve capabilities." },
        { status: response.status }
      );
    }

    const result = await response.json();

    return NextResponse.json(result);
  } catch {
    return NextResponse.json(
      { error: "Paiflow connection failed." },
      { status: 502 }
    );
  }
}
