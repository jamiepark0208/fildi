/**
 * Unusual options activity (A396, north-star #2): LSE OPRA prints ≥ $25k premium
 * (scripts/watchlist_sync/options_flow.py → watchlist_sync.options_flow_prints / options_flow_daily). Stored data only.
 * Trades carry no bid/ask, so a print's side (bought vs sold) is unknown — the UI says so. Display only, untested edge.
 *   GET /api/stocks/:ticker/options-flow?days=20   daily series + latest day's top contracts and biggest prints
 *   GET /api/options-flow/latest                   latest day: most unusual vs own baseline, biggest premium, put-heavy
 */
import { Router } from "express";
import { sql } from "drizzle-orm";
import { db } from "@workspace/db";
import { logger } from "../lib/logger.js";
import { TTLCache } from "../lib/ttl-cache.js";
import { fetchGexProfile, type GexProfile } from "../lib/gex-daily.js";

const router = Router();

type Raw = Record<string, unknown>;
const num = (v: unknown): number | null => (v == null || v === "" || !Number.isFinite(Number(v)) ? null : Number(v));
const day = (v: unknown): string | null => (v == null ? null : v instanceof Date ? v.toISOString().slice(0, 10) : String(v).slice(0, 10));

export interface FlowContract {
  occ: string; side: "call" | "put" | null; strike: number | null; expiry: string | null; dte: number | null;
  premium: number; size: number; prints: number; iv: number | null; delta: number | null; volume: number | null; oi: number | null;
}
export interface FlowDay {
  day: string; ticker: string; prints: number; callPremium: number; putPremium: number; totalPremium: number;
  putShare: number | null; blocks: number; bursts: number; maxPrint: number | null; xNormal: number | null;
  baselineDays: number; top: FlowContract[];
}

function mapContract(c: Raw): FlowContract {
  return {
    occ: String(c.occ ?? ""), side: c.side === "call" || c.side === "put" ? c.side : null, strike: num(c.strike),
    expiry: day(c.expiry), dte: num(c.dte), premium: num(c.premium) ?? 0, size: num(c.size) ?? 0, prints: num(c.prints) ?? 0,
    iv: num(c.iv), delta: num(c.delta), volume: num(c.volume), oi: num(c.oi),
  };
}

export function mapDay(r: Raw): FlowDay {
  const call = num(r.call_premium) ?? 0;
  const put = num(r.put_premium) ?? 0;
  const tot = call + put;
  const top = Array.isArray(r.top) ? (r.top as Raw[]).map(mapContract) : [];
  return {
    day: day(r.day) ?? "", ticker: String(r.ticker), prints: num(r.prints) ?? 0, callPremium: call, putPremium: put,
    totalPremium: tot, putShare: tot > 0 ? put / tot : null, blocks: num(r.blocks) ?? 0, bursts: num(r.bursts) ?? 0,
    maxPrint: num(r.max_print), xNormal: num(r.premium_x_norm), baselineDays: num(r.baseline_days) ?? 0, top,
  };
}

/** Most unusual: premium ≥ 3× the name's own median (≥ 5 baseline days) and ≥ $500k total, ranked by the multiple. */
export function rankUnusual(rows: FlowDay[], minX = 3, minPremium = 500_000, n = 15): FlowDay[] {
  return rows
    .filter((r) => r.xNormal != null && r.xNormal >= minX && r.baselineDays >= 5 && r.totalPremium >= minPremium)
    .sort((a, b) => (b.xNormal ?? 0) - (a.xNormal ?? 0))
    .slice(0, n);
}

const EXCLUDE_INDEX = new Set(["SPY", "QQQ", "IWM"]);

router.get("/stocks/:ticker/options-flow", async (req, res) => {
  const t = String(req.params.ticker ?? "").toUpperCase();
  if (!/^[A-Z0-9.\-]{1,12}$/.test(t)) return res.status(400).json({ error: "bad ticker" });
  const days = Math.min(60, Math.max(1, Number(req.query.days) || 20));
  try {
    const r = await db.execute(sql`SELECT * FROM watchlist_sync.options_flow_daily WHERE ticker = ${t} ORDER BY day DESC LIMIT ${days}`);
    const series = (r.rows as Raw[]).map(mapDay);
    const latest = series[0] ?? null;
    let prints: Raw[] = [];
    if (latest) {
      const p = await db.execute(sql`SELECT occ, ts, side, strike, expiry, dte, size, price, premium, iv, delta, venue, underlying_price
        FROM watchlist_sync.options_flow_prints WHERE underlying = ${t} AND day = ${latest.day} ORDER BY premium DESC LIMIT 15`);
      prints = p.rows as Raw[];
    }
    return res.json({
      ticker: t, latest, series,
      prints: prints.map((x) => ({
        occ: String(x.occ), ts: x.ts instanceof Date ? x.ts.toISOString() : String(x.ts), side: x.side, strike: num(x.strike),
        expiry: day(x.expiry), dte: num(x.dte), size: num(x.size), price: num(x.price), premium: num(x.premium), iv: num(x.iv),
        delta: num(x.delta), venue: x.venue, spot: num(x.underlying_price),
      })),
    });
  } catch (err) {
    logger.warn({ err, t }, "options flow ticker failed");
    return res.json({ ticker: t, latest: null, series: [], prints: [] });
  }
});

router.get("/options-flow/latest", async (_req, res) => {
  try {
    const d = await db.execute(sql`SELECT max(day) AS d, count(DISTINCT day)::int AS n FROM watchlist_sync.options_flow_daily`);
    const latestDay = day((d.rows[0] as Raw)?.d);
    if (!latestDay) return res.json({ day: null, unusual: [], biggest: [], putHeavy: [], index: [], days: 0 });
    const r = await db.execute(sql`SELECT * FROM watchlist_sync.options_flow_daily WHERE day = ${latestDay} AND prints > 0`);
    const rows = (r.rows as Raw[]).map(mapDay);
    const single = rows.filter((x) => !EXCLUDE_INDEX.has(x.ticker));
    return res.json({
      day: latestDay,
      days: num((d.rows[0] as Raw)?.n) ?? 0,
      names: rows.length,
      unusual: rankUnusual(single),
      biggest: [...single].sort((a, b) => b.totalPremium - a.totalPremium).slice(0, 10),
      putHeavy: single.filter((x) => x.totalPremium >= 1_000_000 && (x.putShare ?? 0) >= 0.7)
        .sort((a, b) => b.putPremium - a.putPremium).slice(0, 10),
      index: rows.filter((x) => EXCLUDE_INDEX.has(x.ticker)),
    });
  } catch (err) {
    logger.warn({ err }, "options flow latest failed");
    return res.json({ day: null, unusual: [], biggest: [], putHeavy: [], index: [], days: 0 });
  }
});

// North-star #7 — dealer GEX by strike (live Schwab chain; OI is yesterday's close, so 15 min is plenty).
export const gexCache = new TTLCache<GexProfile>(15 * 60 * 1000, "gex-profile", 300);

router.get("/stocks/:ticker/gex", async (req, res) => {
  const t = String(req.params.ticker ?? "").toUpperCase();
  if (!/^[A-Z0-9.\-]{1,12}$/.test(t)) return res.status(400).json({ error: "bad ticker" });
  try {
    const profile = await gexCache.getOrCompute(t, async () => {
      const p = await fetchGexProfile(t);
      if (!p) throw new Error("no chain");
      return p;
    });
    return res.json({ ticker: t, profile });
  } catch (err) {
    logger.debug({ err: String(err), t }, "gex profile unavailable");
    return res.json({ ticker: t, profile: null });
  }
});

export default router;
