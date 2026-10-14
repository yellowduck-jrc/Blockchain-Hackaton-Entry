import { afterEach, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { emergencyPaiflow } from "@/lib/paiflow";
const tuples = [
  ["parents", "PARENT", "3f61d495-5bfa-4f51-b4e3-f666fc7bf22d", "a"],
  ["brother", "BROTHER", "d34c35d4-10e0-4b59-9b98-425a1a503023", "b"],
  ["sister", "SISTER", "73ebc55f-1a70-4ddd-8172-b05489871c85", "c"],
] as const;
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });
it.each(tuples)("uses only %s deployment credentials without needing Instant credentials", async (recipient, prefix, id, character) => {
  vi.stubEnv("PAIFLOW_MODE", "team"); vi.stubEnv("PAIFLOW_BASE_URL", "https://platform.test");
  vi.stubEnv("PAIFLOW_API_TOKEN", ""); vi.stubEnv("PAIFLOW_DEPLOYMENT_ID", "instant-split");
  const token = `pfk_${character.repeat(64)}`;
  vi.stubEnv(`PAIFLOW_EMERGENCY_POT_${prefix}_DEPLOYMENT_ID`, id);
  vi.stubEnv(`PAIFLOW_EMERGENCY_POT_${prefix}_API_TOKEN`, token);
  const fetch = vi.fn().mockImplementation(async () => new Response(JSON.stringify({ data: { status: "PENDING" } })));
  vi.stubGlobal("fetch", fetch);
  const api = emergencyPaiflow(recipient);
  await api.capabilities(); await api.prepare("payer", "500000000"); await api.submit("original-signed-envelope"); await api.status("a".repeat(64));
  expect(fetch).toHaveBeenCalledTimes(4);
  expect(fetch.mock.calls.every(([url, options]) => String(url).startsWith(`https://platform.test/api/v1/deployments/${id}/`) && options.headers.Authorization === `Bearer ${token}`)).toBe(true);
  expect(JSON.parse(fetch.mock.calls[1]![1].body)).toEqual({ from: "payer", amount: "500000000" });
  expect(String(fetch.mock.calls[2]![0])).toContain("execute/submit?wait=false");
});
it("refuses emergency API calls in preparation or shared demo mode", () => {
  vi.stubEnv("PAIFLOW_MODE", "demo"); expect(() => emergencyPaiflow("brother")).toThrow();
  vi.stubEnv("PAIFLOW_MODE", "prepare"); expect(() => emergencyPaiflow("brother")).toThrow();
});
