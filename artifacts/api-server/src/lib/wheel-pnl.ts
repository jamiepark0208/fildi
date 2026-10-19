/**
 * A92 — per-ticker wheel P&L (options + stock + dividends).
 * Port of scripts/watchlist_sync/wheel.py — one home for the Track Record drill-down.
 */
import { sql } from "drizzle-orm";
import { db } from "@workspace/db";

export interface WheelPnl {
  options: number;
  stockRealized: number;
  stockUnrealized: number;
  dividends: number;
  /** null when avg cost unknown for an open holding. */
  total: number | null;
  costUnknown: boolean;
}

function n(v: unknown): number {
  const x = typeof v === "number" ? v : parseFloat(String(v ?? ""));
  return Number.isFinite(x) ? x : 0;
}

async function stockUnrealizedByTicker(): Promise<{ unreal: Map<string, number>; unknown: Set<string> }> {
  const latest = await db.execute<{ id: number | null }>(sql`
    SELECT max(snapshot_id)::int AS id FROM portfolio_positions`);
  const latestId = latest.rows[0]?.id;
  const unreal = new Map<string, number>();
  const unknown = new Set<string>();
  if (latestId == null) return { unreal, unknown };

  const prior = await db.execute<{ id: number | null }>(sql`
    SELECT max(snapshot_id)::int AS id FROM portfolio_positions
    WHERE avg_cost > 0 AND snapshot_id < ${latestId}`);
  const priorId = prior.rows[0]?.id;
  const prev = new Map<string, { qty: number; avg: number }>();
  if (priorId != null) {
    const prevRows = await db.execute<{
      account: string; symbol: string; quantity: string; avg_cost: string;
    }>(sql`
      SELECT account, symbol, quantity::text, avg_cost::text
      FROM portfolio_positions WHERE snapshot_id = ${priorId} AND avg_cost > 0`);
    for (const r of prevRows.rows) {
      prev.set(`${r.account}|${r.symbol}`, { qty: n(r.quantity), avg: n(r.avg_cost) });
    }
  }

  const cur = await db.execute<{
    account: string; symbol: string; quantity: string; avg_cost: string; market_value: string;
  }>(sql`
    SELECT account, symbol, quantity::text, avg_cost::text, market_value::text
    FROM portfolio_positions WHERE snapshot_id = ${latestId}`);
  for (const r of cur.rows) {
    const qty = n(r.quantity);
    let avg = n(r.avg_cost);
    const mv = n(r.market_value);
    if (!(qty > 0)) continue;
    if (!(avg > 0)) {
      const p = prev.get(`${r.account}|${r.symbol}`);
      avg = p && p.qty === qty ? p.avg : 0;
    }
    if (!(avg > 0)) {
      unknown.add(r.symbol);
      continue;
    }
    unreal.set(r.symbol, (unreal.get(r.symbol) ?? 0) + (mv - qty * avg));
  }
  return { unreal, unknown };
}

/** Wheel totals for one ticker (all accounts rolled). */
export async function getWheelPnl(ticker: string): Promise<WheelPnl | null> {
  const t = ticker.toUpperCase();
  const { unreal, unknown } = await stockUnrealizedByTicker();
  const earn = await db.execute<{
    options: string; stock_realized: string; dividends: string;
  }>(sql`
    SELECT sum(coalesce(sell_put,0) + coalesce(sell_call,0) + coalesce(long_call,0)
             + coalesce(long_put,0))::text AS options,
           sum(coalesce(stocks_realized,0))::text AS stock_realized,
           sum(coalesce(dividends,0))::text AS dividends
    FROM portfolio_ticker_earnings WHERE ticker = ${t}`);
  const row = earn.rows[0];
  const options = n(row?.options);
  const stockRealized = n(row?.stock_realized);
  const dividends = n(row?.dividends);
  const stockUnrealized = unreal.get(t) ?? 0;
  const costUnknown = unknown.has(t);
  const hasAny = options || stockRealized || dividends || stockUnrealized || costUnknown || unreal.has(t);
  if (!hasAny) return null;
  return {
    options: Math.round(options),
    stockRealized: Math.round(stockRealized),
    stockUnrealized: Math.round(stockUnrealized),
    dividends: Math.round(dividends),
    total: costUnknown ? null : Math.round(options + stockRealized + stockUnrealized + dividends),
    costUnknown,
  };
}
