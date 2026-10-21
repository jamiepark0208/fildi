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
import {
  getChampionScorecardParams,
  getChallengerScorecardParams,
  getScorecardParamsByVersion,
} from "./scorecard-params.js";
import { logger } from "./logger.js";

type SqlRows<T> = T[] | { rows?: T[] };
const rowsOf = <T,>(r: SqlRows<T>): T[] => (Array.isArray(r) ? r : r.rows ?? []);

export interface PutScoringInputs {
  version: string;
  /** Options champion strike weights (undefined = code defaults). */
  strikeWeights: Record<string, number> | undefined;
  /** Put-lane technical weights (undefined = engine defaults, i.e. the display score). */
  putTechWeights: Record<string, number> | undefined;
  /** Call-lane technical weights (S046; undefined = engine defaults). */
  callTechWeights: Record<string, number> | undefined;
}

function inputsFromParams(version: string, params: Record<string, unknown>): PutScoringInputs {
  const p = params as {
    strikeWeights?: Record<string, number>;
    putTechWeights?: Record<string, number>;
    callTechWeights?: Record<string, number>;
  };
  return {
    version,
    strikeWeights: p.strikeWeights,
    putTechWeights: p.putTechWeights,
    callTechWeights: p.callTechWeights,
  };
}

export async function loadPutScoringInputs(): Promise<PutScoringInputs> {
  const champ = await getChampionScorecardParams("options");
  return inputsFromParams(champ.version, champ.params);
}

/**
 * A172/A191: record-only re-score of the same strike.
 * Prefer an active options challenger (A191 shadow-first); else champion.parent (A172).
 */
export async function loadShadowInputs(): Promise<PutScoringInputs | null> {
  const challenger = await getChallengerScorecardParams("options");
  if (challenger) return inputsFromParams(challenger.version, challenger.params);
  const champ = await getChampionScorecardParams("options");
  if (!champ.parent) return null;
  const parent = await getScorecardParamsByVersion(champ.parent);
  if (!parent || parent.lane !== "options") return null;
  return inputsFromParams(parent.version, parent.params);
}

/**
 * Lane tech totals per ticker. With champion lane weights: new ordering, levels matched to the
 * default-weight distribution (keeps the stockQuality floor's meaning). Without: default weights.
 */
export function laneTechScores(
  rows: TechnicalRow[], weights: Record<string, number> | undefined, side: "put" | "call",
): Map<string, number> {
  const base = new Map(computeTechnicalRankingsV2(rows, {}, undefined, side).map((s) => [s.ticker, s.totalScore]));
  if (!weights) return base;
  const tuned = new Map(computeTechnicalRankingsV2(rows, {}, weights, side).map((s) => [s.ticker, s.totalScore]));
  return matchDistribution(tuned, base);
}

export function putTechScores(rows: TechnicalRow[], putTechWeights: Record<string, number> | undefined): Map<string, number> {
  return laneTechScores(rows, putTechWeights, "put");
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
