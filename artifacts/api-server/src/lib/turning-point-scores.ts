import { pool } from "@workspace/db";
import { logger } from "./logger.js";

export type TurningPointRow = {
  horizon: string;
  side: string;
  prob: number;
  decile: number;
  base: number;
  modelVersion: string;
};

export type TurningPointSummary = {
  asOf: string | null;
  weekLow: TurningPointRow | null;
  monthHigh: TurningPointRow | null;
  line: string | null;
};

function pct(x: number): string {
  return `${(x * 100).toFixed(1)}%`;
}

export function formatTurningPointLine(rows: TurningPointRow[]): string | null {
  const wl = rows.find((r) => r.horizon === "week" && r.side === "low");
  const mh = rows.find((r) => r.horizon === "month" && r.side === "high");
  if (!wl && !mh) return null;
  const parts: string[] = [];
  if (wl) {
    parts.push(`week-low odds ${pct(wl.prob)} vs base ${pct(wl.base)} (decile ${wl.decile})`);
  }
  if (mh) {
    parts.push(`month-high ${pct(mh.prob)} vs base ${pct(mh.base)} (decile ${mh.decile})`);
  }
  return `Turning point: ${parts.join(", ")} — S151, timing tilt 1.3–1.8×, context only`;
}

export async function readTurningPointScores(ticker: string, asOf?: string | null): Promise<TurningPointSummary> {
  const upper = ticker.toUpperCase();
  try {
    const r = await pool.query<{
      as_of: string;
      horizon: string;
      side: string;
      prob: number;
      decile: number;
      base: number;
      model_version: string;
    }>(
      asOf
        ? `SELECT as_of::text, horizon, side, prob, decile, base, model_version
           FROM watchlist_sync.turning_point_scores
           WHERE ticker = $1 AND as_of = $2::date AND horizon IN ('week','month') AND side IN ('low','high')`
        : `SELECT DISTINCT ON (horizon, side) as_of::text, horizon, side, prob, decile, base, model_version
           FROM watchlist_sync.turning_point_scores
           WHERE ticker = $1 AND horizon IN ('week','month') AND side IN ('low','high')
           ORDER BY horizon, side, as_of DESC`,
      asOf ? [upper, asOf] : [upper],
    );
    const rows: TurningPointRow[] = r.rows.map((x) => ({
      horizon: x.horizon,
      side: x.side,
      prob: Number(x.prob),
      decile: Number(x.decile),
      base: Number(x.base),
      modelVersion: x.model_version,
    }));
    const asOfOut = r.rows[0]?.as_of ?? null;
    return {
      asOf: asOfOut,
      weekLow: rows.find((x) => x.horizon === "week" && x.side === "low") ?? null,
      monthHigh: rows.find((x) => x.horizon === "month" && x.side === "high") ?? null,
      line: formatTurningPointLine(rows),
    };
  } catch (err) {
    logger.debug({ err: String(err), ticker: upper }, "turning_point_scores read skipped");
    return { asOf: null, weekLow: null, monthHigh: null, line: null };
  }
}

export async function readIndicatorsDailyPayload(ticker: string): Promise<Record<string, unknown> | null> {
  const upper = ticker.toUpperCase();
  try {
    const r = await pool.query<{ payload: Record<string, unknown> }>(
      `SELECT payload FROM watchlist_sync.indicators_daily
       WHERE ticker = $1 ORDER BY as_of DESC LIMIT 1`,
      [upper],
    );
    return r.rows[0]?.payload ?? null;
  } catch {
    return null;
  }
}
