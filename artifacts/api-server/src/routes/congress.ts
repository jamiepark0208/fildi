/**
 * Congress trades (A394): Senate + House STOCK Act disclosures (FMP *-latest → watchlist_sync.congress_trades, scripts/watchlist_sync/congress_trades.py).
 * Stored data only. Display only, untested edge (Ziobrowski 2004 vs Eggers & Hainmueller 2013). Disclosure lag (30-45 d) is part of every row.
 *   GET /api/stocks/:ticker/congress   last 3 y rows + 90 d / 1 y buy vs sell counts and $ midpoint totals
 *   GET /api/congress/latest?days=30&universe=1   newest disclosures (universe names) + top names by net $ bought 90 d
 * History accrues forward from the first run (our FMP plan serves page 0 of *-latest only) → `coverage.since` is returned for the UI to show.
 */
import { Router } from "express";
import { sql } from "drizzle-orm";
import { db } from "@workspace/db";
import { logger } from "../lib/logger.js";

const router = Router();

export interface CongressRow {
  chamber: "senate" | "house";
  symbol: string;
  member: string | null;
  district: string | null;
  owner: string | null;
  txnDate: string | null;
  disclosedDate: string | null;
  lagDays: number | null;
  type: "buy" | "sell" | "exchange" | "other";
  rawType: string | null;
  amountLo: number | null;
  amountHi: number | null;
  amountText: string | null;
  assetType: string | null;
  link: string | null;
}

type Raw = Record<string, unknown>;
const num = (v: unknown): number | null => (v == null || v === "" || !Number.isFinite(Number(v)) ? null : Number(v));
const str = (v: unknown): string | null => (v == null ? null : String(v));
const day = (v: unknown): string | null => (v == null ? null : v instanceof Date ? v.toISOString().slice(0, 10) : String(v).slice(0, 10));

function mapRow(r: Raw): CongressRow {
  return {
    chamber: r.chamber === "senate" ? "senate" : "house",
    symbol: String(r.symbol), member: str(r.member), district: str(r.district), owner: str(r.owner),
    txnDate: day(r.txn_date), disclosedDate: day(r.disclosure_date), lagDays: num(r.lag_days),
    type: (["buy", "sell", "exchange"].includes(String(r.txn_type)) ? r.txn_type : "other") as CongressRow["type"],
    rawType: str(r.raw_type), amountLo: num(r.amount_lo), amountHi: num(r.amount_hi), amountText: str(r.amount_text),
    assetType: str(r.asset_type), link: str(r.link),
  };
}

const mid = (r: CongressRow) => (r.amountLo != null && r.amountHi != null ? (r.amountLo + r.amountHi) / 2 : (r.amountLo ?? r.amountHi ?? 0));

export interface Window { days: number; buys: number; sells: number; buyUsd: number; sellUsd: number; netUsd: number; members: number }

export function summarize(rows: CongressRow[], days: number, today = new Date()): Window {
  const cut = new Date(today.getTime() - days * 86_400_000).toISOString().slice(0, 10);
  const w: Window = { days, buys: 0, sells: 0, buyUsd: 0, sellUsd: 0, netUsd: 0, members: 0 };
  const who = new Set<string>();
  for (const r of rows) {
    if (!r.disclosedDate || r.disclosedDate < cut) continue;
    if (r.type === "buy") { w.buys++; w.buyUsd += mid(r); who.add(r.member ?? "?"); }
    else if (r.type === "sell") { w.sells++; w.sellUsd += mid(r); who.add(r.member ?? "?"); }
  }
  w.netUsd = w.buyUsd - w.sellUsd;
  w.members = who.size;
  return w;
}

async function coverage(): Promise<{ since: string | null; rows: number; lastDisclosed: string | null }> {
  const r = await db.execute(sql`SELECT min(disclosure_date) AS since, max(disclosure_date) AS last, count(*)::int AS n FROM watchlist_sync.congress_trades`);
  const x = (r.rows[0] ?? {}) as Raw;
  return { since: day(x.since), rows: num(x.n) ?? 0, lastDisclosed: day(x.last) };
}

router.get("/stocks/:ticker/congress", async (req, res) => {
  const t = String(req.params.ticker ?? "").toUpperCase();
  if (!/^[A-Z0-9.\-^]{1,12}$/.test(t)) return res.status(400).json({ error: "bad ticker" });
  try {
    const r = await db.execute(sql`SELECT * FROM watchlist_sync.congress_trades WHERE symbol = ${t}
      AND disclosure_date >= (CURRENT_DATE - INTERVAL '3 years') ORDER BY disclosure_date DESC, txn_date DESC NULLS LAST LIMIT 300`);
    const rows = (r.rows as Raw[]).map(mapRow);
    return res.json({ ticker: t, rows, d90: summarize(rows, 90), y1: summarize(rows, 365), coverage: await coverage() });
  } catch (err) {
    logger.warn({ err, t }, "congress ticker failed");
    return res.json({ ticker: t, rows: [], d90: summarize([], 90), y1: summarize([], 365), coverage: { since: null, rows: 0, lastDisclosed: null } });
  }
});

router.get("/congress/latest", async (req, res) => {
  const days = Math.min(365, Math.max(1, Number(req.query.days) || 30));
  const uni = req.query.universe !== "0";
  try {
    const filter = uni ? sql`AND symbol IN (SELECT UPPER(ticker) FROM source_fundamentals)` : sql``;
    const r = await db.execute(sql`SELECT * FROM watchlist_sync.congress_trades WHERE disclosure_date >= (CURRENT_DATE - ${days}::int) ${filter}
      ORDER BY disclosure_date DESC, txn_date DESC NULLS LAST LIMIT 60`);
    const t = await db.execute(sql`SELECT * FROM watchlist_sync.congress_trades WHERE disclosure_date >= (CURRENT_DATE - 90) ${filter}`);
    const by = new Map<string, CongressRow[]>();
    for (const x of (t.rows as Raw[]).map(mapRow)) by.set(x.symbol, [...(by.get(x.symbol) ?? []), x]);
    const top = [...by.entries()]
      .map(([symbol, rs]) => ({ symbol, ...summarize(rs, 90) }))
      .filter((x) => x.buys + x.sells > 0)
      .sort((a, b) => b.netUsd - a.netUsd)
      .slice(0, 10);
    return res.json({ days, universe: uni, rows: (r.rows as Raw[]).map(mapRow), top, coverage: await coverage() });
  } catch (err) {
    logger.warn({ err }, "congress latest failed");
    return res.json({ days, universe: uni, rows: [], top: [], coverage: { since: null, rows: 0, lastDisclosed: null } });
  }
});

export default router;
