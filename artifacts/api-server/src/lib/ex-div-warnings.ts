/**
 * A96: short-call early-assignment risk when ex-div falls before expiry and extrinsic < dividend.
 * Display-only bullets for Portfolio Alerts. Uses Polygon dividends (shared limiter) + latest portfolio_options snapshot.
 */
import { sql } from "drizzle-orm";
import { db } from "@workspace/db";
import { polygonApiKey, polygonFetch } from "./polygon-limiter.js";
import { logger } from "./logger.js";

type SqlRows<T> = T[] | { rows?: T[] };
const rowsOf = <T,>(r: SqlRows<T>): T[] => (Array.isArray(r) ? r : r.rows ?? []);

export type ExDivBullet = {
  key: string;
  level: "amber" | "red";
  text: string;
  value: number;
};

type CallRow = {
  account: string;
  ticker: string;
  strike: number;
  expiry: string;
  qty: number;
  mark: number | null;
  spot: number | null;
};

async function shortCalls(): Promise<CallRow[]> {
  try {
    const legs = rowsOf<{ account: string; ticker: string; strike: number; expiry: string; qty: number; mark: number | null }>((await db.execute(sql`
      SELECT o.account, UPPER(o.symbol) AS ticker, o.strike::float8 AS strike, o.expiration::text AS expiry,
             ABS(o.qty::float8) AS qty, o.mark_price::float8 AS mark
      FROM portfolio_options o
      WHERE o.snapshot_id = (SELECT MAX(snapshot_id) FROM portfolio_options)
        AND o.direction = 'short' AND LOWER(o.option_type) = 'call'
        AND o.expiration >= CURRENT_DATE`)) as SqlRows<never>);
    const out: CallRow[] = [];
    for (const c of legs) {
      const spot = rowsOf<{ c: number }>((await db.execute(sql`
        SELECT close::float8 AS c FROM prices_historical WHERE ticker = ${c.ticker} AND close > 0
        ORDER BY date DESC LIMIT 1`)) as SqlRows<never>)[0]?.c ?? null;
      out.push({ ...c, spot });
    }
    return out;
  } catch (err) {
    logger.warn({ err: String(err) }, "ex-div: portfolio_options read failed");
    return [];
  }
}

async function nextDividend(ticker: string): Promise<{ exDate: string; cash: number } | null> {
  const key = polygonApiKey();
  if (!key) return null;
  const url = `https://api.polygon.io/v3/reference/dividends?ticker=${encodeURIComponent(ticker)}&order=asc&sort=ex_dividend_date&ex_dividend_date.gte=${new Date().toISOString().slice(0, 10)}&limit=1&apiKey=${key}`;
  const res = await polygonFetch(url);
  if (!res.ok) return null;
  const body = (await res.json()) as { results?: Array<{ ex_dividend_date?: string; cash_amount?: number }> };
  const r = body.results?.[0];
  if (!r?.ex_dividend_date || !(r.cash_amount! > 0)) return null;
  return { exDate: r.ex_dividend_date, cash: r.cash_amount! };
}

/** Extrinsic ≈ mark − max(spot − strike, 0) for a short call (per share). */
function extrinsic(mark: number | null, spot: number | null, strike: number): number | null {
  if (mark == null || spot == null || !(mark >= 0) || !(spot > 0)) return null;
  const intrinsic = Math.max(spot - strike, 0);
  return Math.max(mark - intrinsic, 0);
}

export async function exDivWarningBullets(): Promise<ExDivBullet[]> {
  const calls = await shortCalls();
  if (!calls.length) return [];
  const byTicker = new Map<string, CallRow[]>();
  for (const c of calls) {
    const list = byTicker.get(c.ticker) ?? [];
    list.push(c);
    byTicker.set(c.ticker, list);
  }
  const out: ExDivBullet[] = [];
  for (const [ticker, legs] of byTicker) {
    const div = await nextDividend(ticker);
    if (!div) continue;
    for (const c of legs) {
      if (div.exDate > c.expiry) continue;
      const ext = extrinsic(c.mark, c.spot, c.strike);
      if (ext == null) continue;
      if (ext >= div.cash) continue; // extrinsic covers the dividend → less early-assign pressure
      out.push({
        key: `exdiv:${c.account}:${ticker}:${c.strike}:${c.expiry}`,
        level: ext < div.cash * 0.5 ? "red" : "amber",
        value: div.cash,
        text: `${c.account}: short ${ticker} ${c.strike}C ${c.expiry.slice(5)} — ex-div ${div.exDate.slice(5)} ($${div.cash.toFixed(2)}) before expiry; extrinsic $${ext.toFixed(2)} < div → early-assign risk.`,
      });
    }
  }
  return out;
}
