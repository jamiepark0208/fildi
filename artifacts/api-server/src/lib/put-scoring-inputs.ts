/**
 * One home for the put-option scoring inputs both pick paths use (A167 / S045):
 *   - option-score-snapshots (nightly Rankings / Overall)
 *   - model-track-record (Friday model_recs → Model List)
 * Both read the options-lane champion so a model switch moves every stock and both lists at once.
 */
import { sql } from "drizzle-orm";
import { db } from "@workspace/db";
import {
  computeVolumeNodes, computeTechnicalRankingsV2, matchDistribution,
  type DailyBar, type TechnicalRow,
} from "@workspace/option-scoring";
import { getChampionScorecardParams } from "./scorecard-params.js";
import { logger } from "./logger.js";

type SqlRows<T> = T[] | { rows?: T[] };
const rowsOf = <T,>(r: SqlRows<T>): T[] => (Array.isArray(r) ? r : r.rows ?? []);

export interface PutScoringInputs {
  version: string;
  /** Options champion strike weights (undefined = code defaults). */
  strikeWeights: Record<string, number> | undefined;
  /** Put-lane technical weights (undefined = engine defaults, i.e. the display score). */
  putTechWeights: Record<string, number> | undefined;
}

export async function loadPutScoringInputs(): Promise<PutScoringInputs> {
  const champ = await getChampionScorecardParams("options");
  const p = champ.params as { strikeWeights?: Record<string, number>; putTechWeights?: Record<string, number> };
  return { version: champ.version, strikeWeights: p.strikeWeights, putTechWeights: p.putTechWeights };
}

/**
 * Put-lane tech totals per ticker. With champion putTechWeights: new ordering, levels matched to the
 * default-weight distribution (keeps the stockQuality floor's meaning). Without: default weights.
 */
export function putTechScores(rows: TechnicalRow[], putTechWeights: Record<string, number> | undefined): Map<string, number> {
  const base = new Map(computeTechnicalRankingsV2(rows, {}, undefined, "put").map((s) => [s.ticker, s.totalScore]));
  if (!putTechWeights) return base;
  const tuned = new Map(computeTechnicalRankingsV2(rows, {}, putTechWeights, "put").map((s) => [s.ticker, s.totalScore]));
  return matchDistribution(tuned, base);
}

const NODE_SESSIONS = 60;

/** Daily volume-profile nodes per ticker from the last 60 sessions in prices_historical. */
export async function loadVolumeNodes(tickers: string[]): Promise<Map<string, number[]>> {
  const out = new Map<string, number[]>();
  if (tickers.length === 0) return out;
  try {
    const rows = rowsOf<{ ticker: string; high: number; low: number; volume: number }>((await db.execute(sql`
      SELECT ticker, high::float8 AS high, low::float8 AS low, coalesce(volume, 0)::float8 AS volume
      FROM (
        SELECT ticker, date, high, low, volume,
               row_number() OVER (PARTITION BY ticker ORDER BY date DESC) AS rn
        FROM prices_historical
        WHERE ticker IN (${sql.join(tickers.map((t) => sql`${t}`), sql`, `)}) AND close > 0
      ) x
      WHERE rn <= ${NODE_SESSIONS}
      ORDER BY ticker, date`)) as SqlRows<never>);
    const byTicker = new Map<string, DailyBar[]>();
    for (const r of rows) {
      const list = byTicker.get(r.ticker) ?? [];
      list.push({ high: r.high, low: r.low, volume: r.volume });
      byTicker.set(r.ticker, list);
    }
    for (const [t, bars] of byTicker) out.set(t, computeVolumeNodes(bars));
  } catch (err) {
    logger.warn({ err: String(err) }, "put-scoring-inputs: volume nodes unavailable (nodeGap drops out)");
  }
  return out;
}
