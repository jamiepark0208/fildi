/**
 * A172 — re-score the champion-chosen put with parent (shadow) params.
 * Does not change the pick; returns null if the shadow score cannot be computed.
 */
import {
  buildCandidate,
  computeOptionScore,
  applyCalibrationToScore,
  type StockContext,
  type MacroRegime,
  type CalibrationTable,
} from "@workspace/option-scoring";

type OptLike = {
  strike: number;
  bid: number;
  ask: number;
  iv: number;
  volume: number | null;
  openInterest: number | null;
  delta: number | null;
  spreadPct: number | null;
  incomePct: number;
  bidIsLive?: boolean;
  quoteStale?: boolean;
};

type ChainLike = { spot: number; exactDte: number; settlementDte?: number };

export function scoreShadowOnChosenStrike(opts: {
  opt: OptLike;
  chain: ChainLike;
  /** Stock context already using shadow put-lane tech totals. */
  stockCtx: StockContext;
  regime: MacroRegime;
  allWatchlistIVs: number[];
  strikeWeights?: Record<string, number>;
  earningsHaircut?: number;
  calibration?: CalibrationTable | null;
}): number | null {
  const { opt, chain, stockCtx, regime, allWatchlistIVs, strikeWeights, earningsHaircut, calibration } = opts;
  if (!(opt.bid > 0) || opt.bidIsLive === false) return null;
  const candidate = buildCandidate(opt, chain, false);
  const scoreOpts = earningsHaircut != null
    ? { earningsHaircutDeep: Math.min(0.99, earningsHaircut + 0.06), earningsHaircutNear: earningsHaircut }
    : undefined;
  const result = computeOptionScore(
    candidate, stockCtx, regime, allWatchlistIVs, strikeWeights, false, scoreOpts,
  );
  if (!(result.optionScore >= 0)) return null;
  const cal = applyCalibrationToScore(result.optionScore, "put", calibration ?? null);
  if (cal.skip) return null;
  const score = cal.multiplier < 1
    ? Math.round(result.optionScore * cal.multiplier * 10) / 10
    : result.optionScore;
  return score;
}
