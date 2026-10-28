import { appendFileSync, mkdirSync } from "node:fs";
import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "./schema";

const { Pool } = pg;

if (!process.env.DATABASE_URL) {
  throw new Error(
    "DATABASE_URL must be set. Did you forget to provision a database?",
  );
}

// Shared by Drizzle queries + connect-pg-simple sessions (app.ts) — default max (10) was
// getting starved by data-health's full table scans during enrichment under concurrent load.
export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: Number(process.env.DATABASE_POOL_MAX ?? 20),
  idleTimeoutMillis: 30_000,
});
// An idle client dropped by the server (Postgres restart → 57P01) is emitted here; unhandled it became an
// uncaughtException that took the API down (10-24). The pool discards the client and reconnects on the next query.
// A251: count + last error → healthz "degraded" (do not hide real outages).
let poolErrorCount = 0;
let poolLastError: { at: string; code: string; message: string } | null = null;
const onClientError = (err: Error) => {
  const code = (err as { code?: string }).code ?? "";
  poolErrorCount += 1;
  poolLastError = { at: new Date().toISOString(), code, message: err.message.slice(0, 200) };
  console.error(`[db] client error #${poolErrorCount} (pool reconnects): ${code} ${err.message}`);
  try {
    mkdirSync("/tmp/fildi-logs", { recursive: true });
    appendFileSync(
      "/tmp/fildi-logs/db-pool-errors.jsonl",
      JSON.stringify({ t: poolLastError.at, n: poolErrorCount, code, message: poolLastError.message }) + "\n",
    );
  } catch { /* log dir may be missing */ }
};
pool.on("error", onClientError);
// Checked-out clients (e.g. the enrichment advisory-lock holder) emit on the client, not the pool → handle there too;
// their in-flight/next query still rejects normally.
pool.on("connect", (client) => client.on("error", onClientError));

/** A251 — for /api/healthz degraded signal after Postgres blips. */
export function getPoolErrorStats() {
  return { count: poolErrorCount, last: poolLastError };
}

export const db = drizzle(pool, { schema });

export * from "./schema";
export { ETF_EXCLUSIONS, isExcludedEtf, isEtfQuoteType } from "./etf-exclusions";
