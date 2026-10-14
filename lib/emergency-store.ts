import "server-only";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import path from "node:path";
import type { EmergencyPayment, EmergencyRequest } from "@/lib/emergency";

export type EmergencyAttempt = EmergencyPayment & { version: 1; request: EmergencyRequest; origin: string; updatedAt: string };
export class EmergencyConflict extends Error {}
// Single durable filesystem shared by this local Node server. Never put this on an
// ephemeral/serverless filesystem or split it between deployment instances.
const directory = () => path.join(process.cwd(), ".data", "emergency-payments");
export async function withEmergencyAttempt<T>(origin: string, requestId: string, action: (attempt: EmergencyAttempt | null, save: (attempt: EmergencyAttempt) => Promise<void>) => Promise<T>): Promise<T> {
  const key = createHash("sha256").update(`${origin}:${requestId}`).digest("hex");
  const root = directory();
  await mkdir(root, { recursive: true });
  const file = path.join(root, `${key}.json`);
  const lockPath = path.join(root, `${key}.lock`);
  let lock;
  try { lock = await open(lockPath, "wx", 0o600); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new EmergencyConflict("Another payment operation is running, or its server lock needs operator review. Recheck the original attempt; do not replace it."); throw error; }
  try {
    let attempt: EmergencyAttempt | null = null;
    try {
      attempt = JSON.parse(await readFile(file, "utf8"));
      if (!attempt || attempt.version !== 1 || attempt.requestId !== requestId || attempt.origin !== origin) throw new Error("Invalid durable payment record.");
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    async function save(record: EmergencyAttempt) {
      const temporary = `${file}.${randomUUID()}.tmp`;
      const handle = await open(temporary, "wx", 0o600);
      try { await handle.writeFile(JSON.stringify({ ...record, updatedAt: new Date().toISOString() })); await handle.sync(); } finally { await handle.close(); }
      await rename(temporary, file);
    }
    return await action(attempt, save);
  } finally { await lock.close(); await unlink(lockPath); }
}
export function publicEmergencyAttempt(attempt: EmergencyAttempt): EmergencyPayment {
  const { state, requestId, deploymentId, wallet, amount, payer, txHash, prepared, signedXdr, ledger, message } = attempt;
  return { state, requestId, deploymentId, wallet, amount, payer, txHash, prepared, signedXdr, ledger, message };
}
