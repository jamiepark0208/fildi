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

/** Tickers whose snapshot is missing or not fresh (keeps input order). */
export async function staleChainTickers(tickers: string[]): Promise<string[]> {
  if (!tickers.length) return [];
  await ensureTable();
  const fresh = new Set(rowsOf<{ ticker: string; fetched_at: string }>((await db.execute(sql`
    SELECT ticker, fetched_at::text FROM options_chain_snapshot
    WHERE ticker = ANY(${`{${tickers.join(",")}}`}::text[])`)) as SqlRows<never>)
    .filter((r) => chainIsFresh(Date.parse(r.fetched_at))).map((r) => r.ticker));
  return tickers.filter((t) => !fresh.has(t));
}

/** Last minute the market was open, cached 5 min (walks back in 10-min steps; ≤ 4 days → covers weekends). */
let lastOpenCache: { at: number; v: number } | null = null;
function lastOpenMinute(now = Date.now()): number {
  if (lastOpenCache && Math.abs(now - lastOpenCache.at) < 5 * 60_000) return lastOpenCache.v;
  let t = now;
  for (let i = 0; i < 4 * 144 && !inMarketHours(new Date(t)); i++) t -= 10 * 60_000;
  lastOpenCache = { at: now, v: t };
  return t;
}

/** In market hours: < CHAIN_FRESH_MS old. Outside: taken at/after the last open minute (quotes can't have moved since). */
export function chainIsFresh(fetchedAt: number, now = Date.now()): boolean {
  if (inMarketHours(new Date(now))) return now - fetchedAt < CHAIN_FRESH_MS;
  return fetchedAt >= lastOpenMinute(now) - 10 * 60_000;
}

/** Names the app shows chains for: watchlist, today's sold-put picks, latest Model List option folders (not the
 *  588-name watch / own folders — ~900 names would be ~40 Schwab calls/min). Ranked names are added by the caller. */
export async function chainUniverse(): Promise<string[]> {
  await ensureTable();
  const rows = rowsOf<{ ticker: string }>((await db.execute(sql`
    SELECT ticker FROM public.watchlist
    UNION SELECT ticker FROM watchlist_sync.put_recs_daily
      WHERE as_of = (SELECT max(as_of) FROM watchlist_sync.put_recs_daily) AND pass
    UNION SELECT ticker FROM watchlist_sync.model_items WHERE run_id = (SELECT max(run_id) FROM watchlist_sync.model_items)
      AND folder_key IN ('income', 'sell_puts', 'sell_calls', 'manage', 'holdings', 'trim_risk')`)) as SqlRows<never>);
  return [...new Set(rows.map((r) => r.ticker.toUpperCase()).filter((t) => /^[A-Z]{1,10}$/.test(t)))];
}

/** US regular session ± 10 min, weekdays (ET). Chains don't move outside it, so the warmer sleeps. */
export function inMarketHours(now = new Date()): boolean {
  const et = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", weekday: "short", hour: "2-digit", minute: "2-digit", hour12: false })
    .formatToParts(now).reduce<Record<string, string>>((m, p) => ({ ...m, [p.type]: p.value }), {});
  if (et.weekday === "Sat" || et.weekday === "Sun") return false;
  const mins = Number(et.hour) * 60 + Number(et.minute);
  return mins >= 9 * 60 + 20 && mins <= 16 * 60 + 10;
}
