/**
 * A81 — put-seller mover facts (Claude-narrowed: no advice takes).
 * move %, driver hint, IV today vs yesterday, realized-vol rank.
 */
import { pool } from "@workspace/db";
import { getLivePrices } from "./live-quote.js";

export type MoverFact = {
  ticker: string;
  movePct: number | null;
  driver: "earnings" | "unknown";
  driverDetail: string | null;
  ivToday: number | null;
  ivYesterday: number | null;
  ivDeltaPctPts: number | null;
  /** DB ivRank — realized-vol proxy (A99 label). */
  rvRank: number | null;
};

async function ivByDay(tickers: string[]): Promise<Map<string, { today: number | null; yesterday: number | null }>> {
  const out = new Map<string, { today: number | null; yesterday: number | null }>();
  if (tickers.length === 0) return out;
  try {
    const r = await pool.query<{ ticker: string; as_of: string; avg_iv: string }>(`
      SELECT UPPER(ticker) AS ticker, as_of::text, AVG(iv)::float8::text AS avg_iv
      FROM option_chain_history
      WHERE UPPER(ticker) = ANY($1::text[])
        AND side = 'put'
        AND iv IS NOT NULL AND iv > 0
        AND dte BETWEEN 5 AND 21
        AND as_of >= CURRENT_DATE - 5
      GROUP BY UPPER(ticker), as_of
      ORDER BY UPPER(ticker), as_of DESC
    `, [tickers]);
    const seen = new Map<string, string[]>();
    for (const row of r.rows) {
      const list = seen.get(row.ticker) ?? [];
      if (list.length >= 2) continue;
      list.push(row.avg_iv);
      seen.set(row.ticker, list);
    }
    for (const t of tickers) {
      const list = seen.get(t) ?? [];
      out.set(t, {
        today: list[0] != null ? parseFloat(list[0]) : null,
        yesterday: list[1] != null ? parseFloat(list[1]) : null,
      });
    }
  } catch {
    for (const t of tickers) out.set(t, { today: null, yesterday: null });
  }
  return out;
}

export async function buildMoverFacts(
  tickersIn: string[],
  /** When set, skip getLivePrices and use these % (keeps fact line aligned with screener board). */
  movePctByTicker?: Record<string, number | null>,
): Promise<MoverFact[]> {
  const tickers = [...new Set(tickersIn.map((t) => t.toUpperCase()).filter(Boolean))].slice(0, 80);
  if (tickers.length === 0) return [];

  const needLive = movePctByTicker == null;
  const [live, ivMap, tech] = await Promise.all([
    needLive ? getLivePrices(tickers) : Promise.resolve(new Map<string, { changePercent?: number | null }>()),
    ivByDay(tickers),
    pool.query<{ ticker: string; earnings_days_out: number | null; iv_rank: string | null }>(`
      SELECT UPPER(ticker) AS ticker, earnings_days_out, iv_rank::text
      FROM ticker_technicals
      WHERE UPPER(ticker) = ANY($1::text[])
    `, [tickers]),
  ]);

  const techBy = new Map(tech.rows.map((r) => [r.ticker, r]));
  return tickers.map((ticker) => {
    const movePct = movePctByTicker?.[ticker] ?? live.get(ticker)?.changePercent ?? null;
    const t = techBy.get(ticker);
    const er = t?.earnings_days_out;
    const earnings = er != null && er >= 0 && er <= 2;
    const iv = ivMap.get(ticker) ?? { today: null, yesterday: null };
    const ivToday = iv.today != null && Number.isFinite(iv.today) ? iv.today : null;
    const ivYesterday = iv.yesterday != null && Number.isFinite(iv.yesterday) ? iv.yesterday : null;
    const ivDeltaPctPts =
      ivToday != null && ivYesterday != null ? (ivToday - ivYesterday) * 100 : null;
    const rvRank = t?.iv_rank != null ? parseFloat(t.iv_rank) : null;
    return {
      ticker,
      movePct: movePct != null && Number.isFinite(movePct) ? movePct : null,
      driver: earnings ? "earnings" : "unknown",
      driverDetail: earnings
        ? (er === 0 ? "earnings today" : `earnings in ${er}d`)
        : null,
      ivToday,
      ivYesterday,
      ivDeltaPctPts,
      rvRank: rvRank != null && Number.isFinite(rvRank) ? rvRank : null,
    };
  });
}

/** One-line facts string for UI (no advice). */
export function formatMoverFactLine(f: MoverFact, opts?: { omitMovePct?: boolean }): string {
  const parts: string[] = [];
  // Board already shows screener % — omit here so tooltips don't disagree (IRON +36.3 vs +36.5).
  if (!opts?.omitMovePct && f.movePct != null) {
    parts.push(`${f.movePct >= 0 ? "+" : ""}${f.movePct.toFixed(1)}%`);
  }
  if (f.driverDetail) parts.push(f.driverDetail);
  if (f.ivDeltaPctPts != null) {
    parts.push(`IV ${f.ivDeltaPctPts >= 0 ? "+" : ""}${f.ivDeltaPctPts.toFixed(1)}pt vs yd`);
  } else if (f.ivToday != null) {
    parts.push(`IV ${(f.ivToday * 100).toFixed(0)}%`);
  }
  if (f.rvRank != null) parts.push(`RV rank ${Math.round(f.rvRank * 100)}`);
  return parts.join(" · ");
}
