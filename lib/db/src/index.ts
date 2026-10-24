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
const onClientError = (err: Error) => {
  console.error(`[db] client error (pool reconnects): ${(err as { code?: string }).code ?? ""} ${err.message}`);
};
pool.on("error", onClientError);
// Checked-out clients (e.g. the enrichment advisory-lock holder) emit on the client, not the pool → handle there too;
// their in-flight/next query still rejects normally.
pool.on("connect", (client) => client.on("error", onClientError));
export const db = drizzle(pool, { schema });

export * from "./schema";
export { ETF_EXCLUSIONS, isExcludedEtf, isEtfQuoteType } from "./etf-exclusions";
