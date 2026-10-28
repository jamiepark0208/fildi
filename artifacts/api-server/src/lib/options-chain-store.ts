/**
 * Last fetched option chain per ticker, kept in Postgres (Jamie 10-28: "load options data from the database").
 * GET /api/options/:ticker answers from here at once and refreshes from Schwab/Yahoo in the background when the
 * snapshot is older than CHAIN_FRESH_MS, so a 1–4 s vendor call never sits in front of the page.
 * Payload = the exact OptionsChainResult[] the route returns (fetchedAt inside says how old the quotes are).
 */
import { sql } from "drizzle-orm";
import { db } from "@workspace/db";
import { logger } from "./logger.js";
import type { OptionsChainResult } from "./options.js";

type SqlRows<T> = T[] | { rows?: T[] };
const rowsOf = <T,>(r: SqlRows<T>): T[] => (Array.isArray(r) ? r : r.rows ?? []);

export const CHAIN_FRESH_MS = 30 * 60_000;

let ensured = false;
async function ensureTable(): Promise<void> {
  if (ensured) return;
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS options_chain_snapshot (
      ticker text PRIMARY KEY, fetched_at timestamptz NOT NULL, payload jsonb NOT NULL)`);
  ensured = true;
}

/** Saved chain with expired expiries dropped; null when none saved or nothing left. */
export async function readChainSnapshot(ticker: string): Promise<{ chains: OptionsChainResult[]; fetchedAt: number } | null> {
  await ensureTable();
  const row = rowsOf<{ payload: OptionsChainResult[]; fetched_at: string }>((await db.execute(sql`
    SELECT payload, fetched_at::text FROM options_chain_snapshot WHERE ticker = ${ticker}`)) as SqlRows<never>)[0];
  if (!row) return null;
  const today = new Date().toISOString().slice(0, 10);
  const chains = (row.payload ?? []).filter((c) => c.expiry >= today);
  return chains.length ? { chains, fetchedAt: Date.parse(row.fetched_at) } : null;
}

export async function saveChainSnapshot(ticker: string, chains: OptionsChainResult[]): Promise<void> {
  if (!chains.length) return;
  try {
    await ensureTable();
    await db.execute(sql`
      INSERT INTO options_chain_snapshot (ticker, fetched_at, payload) VALUES (${ticker}, now(), ${JSON.stringify(chains)}::jsonb)
      ON CONFLICT (ticker) DO UPDATE SET fetched_at = excluded.fetched_at, payload = excluded.payload`);
  } catch (err) {
    logger.warn({ ticker, err: String(err) }, "options-chain-store: save failed");
  }
}

/** Tickers whose snapshot is missing or older than CHAIN_FRESH_MS (keeps input order). */
export async function staleChainTickers(tickers: string[]): Promise<string[]> {
  if (!tickers.length) return [];
  await ensureTable();
  const fresh = new Set(rowsOf<{ ticker: string }>((await db.execute(sql`
    SELECT ticker FROM options_chain_snapshot
    WHERE ticker = ANY(${`{${tickers.join(",")}}`}::text[]) AND fetched_at > now() - make_interval(secs => ${CHAIN_FRESH_MS / 1000})`)) as SqlRows<never>)
    .map((r) => r.ticker));
  return tickers.filter((t) => !fresh.has(t));
}
