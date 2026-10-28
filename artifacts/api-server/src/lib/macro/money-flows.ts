/**
 * Money flows (Macro › Key Themes; Jamie 10-28: "track market cap changes to highlight flows across sectors and
 * major players, including the government").
 *   market  — $ market-cap change by sector / peer group / theme basket / top players (our universe, constant shares)
 *   web     — AI money web: research/market-views/ai_deals.json edges; public nodes sized by live cap
 *   gov     — Treasury cash flows (gov_flows.py): monthly MTS deficit + weekly DTS spend / receipts / net borrowing / TGA
 */
import { capChange, readViewsJson, type CapPanel, type CapRow } from "./macro-themes.js";

type W = "1w" | "1m" | "3m";
const WINDOWS: W[] = ["1w", "1m", "3m"];
const B = 1e9;

type Stats = { cap: number; n: number } & Record<`chg${W}` | `pct${W}`, number | null>;
function stats(rows: CapRow[]): Stats {
  const out = { cap: rows.reduce((a, r) => a + r.c0 * r.shares, 0) / B, n: rows.length } as Stats;
  for (const w of WINDOWS) {
    const c = capChange(rows, w);
    out[`chg${w}`] = c.chg / B;
    out[`pct${w}`] = c.pct;
  }
  return out;
}

function contributors(rows: CapRow[], w: W, k = 3) {
  const key = w === "1w" ? "c1w" : w === "1m" ? "c1m" : "c3m";
  return rows
    .filter((r) => r[key] != null)
    .map((r) => ({ ticker: r.ticker, chg: ((r.c0 - (r[key] as number)) * r.shares) / B, pct: (r.c0 / (r[key] as number) - 1) * 100 }))
    .sort((a, b) => Math.abs(b.chg) - Math.abs(a.chg))
    .slice(0, k);
}

function groupBy(rows: CapRow[], f: (r: CapRow) => string) {
  const m = new Map<string, CapRow[]>();
  for (const r of rows) (m.get(f(r)) ?? m.set(f(r), []).get(f(r))!).push(r);
  return m;
}

interface Deals {
  updated: string;
  private: Record<string, { value_b: number | null; as_of: string; note?: string }>;
  deals: { from: string; to: string; type: string; amount_b: number | null; date: string; note?: string }[];
}

export async function buildMoneyFlows(caps: CapPanel | null, w: W) {
  const market = caps ? (() => {
    const total = stats(caps.rows);
    const sectors = [...groupBy(caps.rows, (r) => r.sector)].map(([sector, rows]) => ({
      sector, ...stats(rows), share: stats(rows).cap / total.cap, top: contributors(rows, w),
    })).sort((a, b) => b.cap - a.cap);
    const groups = [...groupBy(caps.rows, (r) => r.group)].map(([group, rows]) => ({
      group, sector: rows[0].sector, ...stats(rows), top: contributors(rows, w, 2),
    }));
    const players = [...caps.rows].sort((a, b) => b.c0 * b.shares - a.c0 * a.shares).slice(0, 25).map((r) => ({
      ticker: r.ticker, sector: r.sector, group: r.group, ...stats([r]), share: (r.c0 * r.shares) / B / total.cap,
    }));
    const baskets = Object.entries(readViewsJson<{ baskets: Record<string, string[]> }>("themes.json")?.baskets ?? {}).map(([basket, tick]) => {
      const set = new Set(tick);
      const rows = caps.rows.filter((r) => set.has(r.ticker));
      return { basket, ...stats(rows), top: contributors(rows, w) };
    });
    return { asOf: caps.asOf, dates: { "1w": caps.d1w, "1m": caps.d1m, "3m": caps.d3m }, total, sectors, groups, players, baskets };
  })() : null;

  const deals = readViewsJson<Deals>("ai_deals.json");
  const capOf = new Map((caps?.rows ?? []).map((r) => [r.ticker, r]));
  const web = deals ? (() => {
    const ids = [...new Set(deals.deals.flatMap((d) => [d.from, d.to]))];
    const nodes = ids.map((id) => {
      const pub = capOf.get(id);
      if (pub) {
        const p1m = pub.c1m ? (pub.c0 / pub.c1m - 1) * 100 : null;
        return { id, public: true, value_b: (pub.c0 * pub.shares) / B, pct1m: p1m, as_of: caps!.asOf };
      }
      const pv = deals.private[id];
      return { id, public: false, value_b: pv?.value_b ?? null, pct1m: null, as_of: pv?.as_of ?? null, note: pv?.note };
    });
    return { updated: deals.updated, nodes, edges: deals.deals };
  })() : null;

  const { pool } = await import("@workspace/db");
  const [mon, wk] = await Promise.all([
    pool.query(`SELECT month::text AS month, receipts::float8 / 1e3 AS receipts, outlays::float8 / 1e3 AS outlays,
                       deficit::float8 / 1e3 AS deficit
                FROM watchlist_sync.gov_flows_monthly WHERE month >= CURRENT_DATE - 760 ORDER BY month`).catch(() => null),
    pool.query(`SELECT date_trunc('week', date)::date::text AS week, sum(spend)::float8 / 1e3 AS spend,
                       sum(receipts)::float8 / 1e3 AS receipts, sum(deficit)::float8 / 1e3 AS deficit,
                       sum(net_borrow)::float8 / 1e3 AS net_borrow, sum(interest)::float8 / 1e3 AS interest,
                       sum(defense)::float8 / 1e3 AS defense,
                       (array_agg(tga_close ORDER BY date DESC))[1]::float8 / 1e3 AS tga
                FROM watchlist_sync.gov_flows_daily WHERE date >= CURRENT_DATE - 190 GROUP BY 1 ORDER BY 1`).catch(() => null),
  ]);
  const monthly = (mon?.rows ?? []) as { month: string; receipts: number; outlays: number; deficit: number }[];
  const last12 = monthly.slice(-12);
  const gov = {
    monthly, weekly: wk?.rows ?? [],
    deficit12m: last12.length === 12 ? last12.reduce((a, r) => a + r.deficit, 0) : null,
    unit: "$B",
  };

  return { window: w, market, web, gov };
}
