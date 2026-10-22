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
export const db = drizzle(pool, { schema });

export * from "./schema";
export { ETF_EXCLUSIONS, isExcludedEtf, isEtfQuoteType } from "./etf-exclusions";
