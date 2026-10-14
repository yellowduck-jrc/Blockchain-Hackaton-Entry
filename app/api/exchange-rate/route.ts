import { NextResponse } from "next/server";

// Frankfurter provides the latest published fiat reference rate (not a USDC redemption quote).
// Cache on the server so multiple viewers don't each hit the upstream service.
export const runtime = "nodejs";

export async function GET() {
  try {
    const response = await fetch("https://api.frankfurter.dev/v1/latest?base=USD&symbols=PHP", {
      next: { revalidate: 1800 },
      signal: AbortSignal.timeout(8000),
    });
    if (!response.ok) throw new Error("Upstream exchange rate request failed");
    const raw: unknown = await response.json();
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("Invalid rate payload");
    const data = raw as Record<string, unknown>;
    const rates = data.rates;
    if (!rates || typeof rates !== "object" || Array.isArray(rates)) throw new Error("Missing rates");
    const php = (rates as Record<string, unknown>).PHP;
    if (data.base !== "USD" || typeof php !== "number" || !Number.isFinite(php) || php <= 0 || php > 1000 || typeof data.date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(data.date)) {
      throw new Error("Invalid USD/PHP reference rate");
    }
    return NextResponse.json(
      { rate: php, date: data.date, source: "Frankfurter", base: "USD", quote: "PHP" },
      { headers: { "Cache-Control": "public, max-age=0, s-maxage=1800" } },
    );
  } catch {
    return NextResponse.json({ error: "PHP exchange rate temporarily unavailable" }, { status: 503 });
  }
}
