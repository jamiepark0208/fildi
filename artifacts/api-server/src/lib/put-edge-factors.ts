/**
 * A191 / S059 — TypeScript shadow put-edge IV factors (A255).
 *
 * Two marginal percentiles (IV30/RV20 and σ(Δln IV30) over ~60 sessions from
 * lseg_research.daily_history), ranked within the fresh non-ETF universe.
 * Shadow-only: option-score-snapshots / model-track-record feed these into
 * shadowCtx only — not the live production stockCtx, and not Python's
 * three-factor composite (IV/RV + vol-of-vol + put_tech) in put_edge.py.
 */
import { sql } from "drizzle-orm";
import { db } from "@workspace/db";
import { isExcludedEtf } from "./etf-exclusions.js";
import { logger } from "./logger.js";

type SqlRows<T> = T[] | { rows?: T[] };
const rowsOf = <T,>(r: SqlRows<T>): T[] => (Array.isArray(r) ? r : r.rows ?? []);

/** Latest IV bar must be within this many calendar days of as-of (matches put_edge.py). */
export const PUT_EDGE_MAX_IV_AGE_DAYS = 7;

export interface PutEdgeFactors {
  ivRv: number;
  volOfVol: number;
  ivRvPct: number;
  volOfVolPct: number;
}

export type PutEdgeBar = { date: string; close: number; iv: number | null };

function rank01(values: number[]): number[] {
  const n = values.length;
  if (n === 0) return [];
  const order = values
    .map((v, i) => ({ v, i }))
    .sort((a, b) => a.v - b.v || a.i - b.i);
  const out = new Array<number>(n);
  for (let r = 0; r < n; r++) out[order[r]!.i] = r / Math.max(n - 1, 1);
  return out;
}

function pstdev(xs: number[]): number {
  if (xs.length < 2) return 0;
  const m = xs.reduce((a, b) => a + b, 0) / xs.length;
  const v = xs.reduce((a, x) => a + (x - m) ** 2, 0) / xs.length;
  return Math.sqrt(v);
}

function parseYmd(s: string): Date {
  const [y, m, d] = s.slice(0, 10).split("-").map(Number);
  return new Date(Date.UTC(y!, m! - 1, d!));
}

function daysBetween(a: string, b: string): number {
  return Math.round((parseYmd(b).getTime() - parseYmd(a).getTime()) / 86_400_000);
}

function todayYmd(): string {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Pure factor math over an in-memory history map (tests + loader).
 * Ranks the full fresh non-ETF universe, then optionally filters to `tickers`.
 */
export function computePutEdgeFactorsFromBars(
  byTicker: Map<string, PutEdgeBar[]>,
  asOf: string,
  tickers?: string[],
): Map<string, PutEdgeFactors> {
  const out = new Map<string, PutEdgeFactors>();
  type Raw = { ticker: string; ivRv: number; volOfVol: number };
  const raw: Raw[] = [];

  for (const [ticker, barsIn] of byTicker) {
    if (isExcludedEtf(ticker)) continue;
    // Copy — trim trailing null-IV bars without mutating caller's arrays.
    let bars = barsIn.slice();
    while (bars.length > 0 && (bars[bars.length - 1]!.iv == null || !(bars[bars.length - 1]!.iv! > 0))) {
      bars = bars.slice(0, -1);
    }
    if (bars.length < 61) continue;
    const last = bars[bars.length - 1]!;
    if (last.iv == null || !(last.iv > 0)) continue;
    // Stale LSEG → drop (do not emit last month's factors).
    if (daysBetween(last.date.slice(0, 10), asOf.slice(0, 10)) > PUT_EDGE_MAX_IV_AGE_DAYS) continue;

    const closes = bars.slice(-21).map((x) => x.close);
    if (closes.length < 21) continue;
    const lr: number[] = [];
    for (let k = 1; k < closes.length; k++) {
      if (closes[k - 1]! > 0 && closes[k]! > 0) lr.push(Math.log(closes[k]! / closes[k - 1]!));
    }
    const rv20 = pstdev(lr) * Math.sqrt(252) * 100;
    if (!(rv20 > 0)) continue;
    const ivRv = last.iv / rv20;
    if (!(ivRv >= 0.3 && ivRv <= 5)) continue;
    const ivs = bars.slice(-61).map((x) => x.iv).filter((v): v is number => v != null && v > 0);
    if (ivs.length < 40) continue;
    const dln: number[] = [];
    for (let k = 1; k < ivs.length; k++) dln.push(Math.log(ivs[k]! / ivs[k - 1]!));
    const volOfVol = pstdev(dln);
    if (!(volOfVol >= 0)) continue;
    raw.push({ ticker, ivRv, volOfVol });
  }

  if (raw.length < 30) return out;
  const ivPct = rank01(raw.map((r) => r.ivRv));
  const vvPct = rank01(raw.map((r) => r.volOfVol));
  const want = tickers?.length
    ? new Set(tickers.map((t) => t.trim().toUpperCase()))
    : null;
  for (let i = 0; i < raw.length; i++) {
    const r = raw[i]!;
    if (want && !want.has(r.ticker.trim().toUpperCase())) continue;
    out.set(r.ticker, {
      ivRv: r.ivRv,
      volOfVol: r.volOfVol,
      ivRvPct: ivPct[i]!,
      volOfVolPct: vvPct[i]!,
    });
  }
  return out;
}

/**
 * Load shadow put-edge IV factors. Always ranks the full fresh non-ETF universe
 * (as-of − 120d … as-of), then returns the requested tickers when provided.
 */
export async function loadPutEdgeFactors(
  tickers?: string[],
  asOf?: string,
): Promise<Map<string, PutEdgeFactors>> {
  const day = (asOf ?? todayYmd()).slice(0, 10);
  try {
    // Full universe for percentiles — never rank inside the candidate list alone (A255).
    const rows = rowsOf<{ ticker: string; date: string; close: number; iv: number | null }>((await db.execute(sql`
      SELECT ticker, date::text AS date, close::float8 AS close, iv30_put::float8 AS iv
      FROM lseg_research.daily_history
      WHERE date BETWEEN (${day}::date - 120) AND ${day}::date
        AND close > 0
      ORDER BY ticker, date
    `)) as SqlRows<never>);

    const byTicker = new Map<string, PutEdgeBar[]>();
    for (const r of rows) {
      const list = byTicker.get(r.ticker) ?? [];
      list.push({ date: r.date, close: r.close, iv: r.iv });
      byTicker.set(r.ticker, list);
    }
    return computePutEdgeFactorsFromBars(byTicker, day, tickers);
  } catch (err) {
    logger.warn({ err: String(err) }, "put-edge-factors: LSEG history unavailable");
    return new Map();
  }
}
