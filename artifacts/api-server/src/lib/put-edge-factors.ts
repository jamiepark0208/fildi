/**
 * A191 / S059 — same factor definitions as scripts/watchlist_sync/put_edge.py:
 * IV30/RV20 and σ(Δln IV30) over ~60 sessions from lseg_research.daily_history,
 * ranked within the returned universe to [0,1] percentiles.
 */
import { sql } from "drizzle-orm";
import { db } from "@workspace/db";
import { logger } from "./logger.js";

type SqlRows<T> = T[] | { rows?: T[] };
const rowsOf = <T,>(r: SqlRows<T>): T[] => (Array.isArray(r) ? r : r.rows ?? []);

export interface PutEdgeFactors {
  ivRv: number;
  volOfVol: number;
  ivRvPct: number;
  volOfVolPct: number;
}

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

/**
 * Load put-edge IV factors for tickers (or all names with enough history when tickers empty).
 * Returns empty map if LSEG history is unavailable.
 */
export async function loadPutEdgeFactors(
  tickers?: string[],
): Promise<Map<string, PutEdgeFactors>> {
  const out = new Map<string, PutEdgeFactors>();
  try {
    const filter = tickers?.length
      ? sql`AND ticker IN (${sql.join(tickers.map((t) => sql`${t}`), sql`, `)})`
      : sql``;
    const rows = rowsOf<{ ticker: string; date: string; close: number; iv: number | null }>((await db.execute(sql`
      SELECT ticker, date::text AS date, close::float8 AS close, iv30_put::float8 AS iv
      FROM lseg_research.daily_history
      WHERE date >= (CURRENT_DATE - 120) AND close > 0 ${filter}
      ORDER BY ticker, date
    `)) as SqlRows<never>);

    type Bar = { close: number; iv: number | null };
    const byTicker = new Map<string, Bar[]>();
    for (const r of rows) {
      const list = byTicker.get(r.ticker) ?? [];
      list.push({ close: r.close, iv: r.iv });
      byTicker.set(r.ticker, list);
    }

    type Raw = { ticker: string; ivRv: number; volOfVol: number };
    const raw: Raw[] = [];
    for (const [ticker, bars] of byTicker) {
      let end = bars.length;
      while (end > 0 && (bars[end - 1]!.iv == null || !(bars[end - 1]!.iv! > 0))) end--;
      const b = bars.slice(0, end);
      if (b.length < 61) continue;
      const last = b[b.length - 1]!;
      if (last.iv == null || !(last.iv > 0)) continue;
      const closes = b.slice(-21).map((x) => x.close);
      if (closes.length < 21) continue;
      const lr: number[] = [];
      for (let k = 1; k < closes.length; k++) {
        if (closes[k - 1]! > 0 && closes[k]! > 0) lr.push(Math.log(closes[k]! / closes[k - 1]!));
      }
      const rv20 = pstdev(lr) * Math.sqrt(252) * 100;
      if (!(rv20 > 0)) continue;
      const ivRv = last.iv / rv20;
      if (!(ivRv >= 0.3 && ivRv <= 5)) continue;
      const ivs = b.slice(-61).map((x) => x.iv).filter((v): v is number => v != null && v > 0);
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
    for (let i = 0; i < raw.length; i++) {
      const r = raw[i]!;
      out.set(r.ticker, {
        ivRv: r.ivRv,
        volOfVol: r.volOfVol,
        ivRvPct: ivPct[i]!,
        volOfVolPct: vvPct[i]!,
      });
    }
  } catch (err) {
    logger.warn({ err: String(err) }, "put-edge-factors: LSEG history unavailable");
  }
  return out;
}
