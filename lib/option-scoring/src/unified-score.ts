// Blends the three scores TradeDash already computes separately (technical
// scorecard, option-strike score, macro regime confidence) into one 1-10
// number, TipRanks-Smart-Score style — a single number to scan across
// tickers, with the component breakdown kept alongside for a hover/tooltip.
// Pure function: no fetches, no side effects, safe to call anywhere the three
// inputs are already in memory.

export interface UnifiedScoreInputs {
  technicalScore: number | null; // 0-100, from computeTechnicalRankingsV2
  optionScore: number | null;    // 0-100, from pickBestStrike
  regimeConfidence: number | null; // 0-100, from the latest market_regime row
}

export interface UnifiedScoreResult {
  score: number; // 1-10
  components: {
    technical: number | null;
    option: number | null;
    regime: number | null;
  };
}

const WEIGHTS = { technical: 0.5, option: 0.3, regime: 0.2 } as const;

export function computeUnifiedScore(inputs: UnifiedScoreInputs): UnifiedScoreResult {
  const parts: Array<{ key: keyof typeof WEIGHTS; value: number }> = [];
  if (inputs.technicalScore != null) parts.push({ key: "technical", value: inputs.technicalScore });
  if (inputs.optionScore != null) parts.push({ key: "option", value: inputs.optionScore });
  if (inputs.regimeConfidence != null) parts.push({ key: "regime", value: inputs.regimeConfidence });

  const availWeight = parts.reduce((s, p) => s + WEIGHTS[p.key], 0);
  const weightedSum = parts.reduce((s, p) => s + WEIGHTS[p.key] * p.value, 0);

  // No inputs available at all — nothing to score.
  const pct = availWeight > 0 ? weightedSum / availWeight : 0; // 0-100
  const raw = pct / 10; // 0-10
  const score = availWeight > 0 ? Math.min(10, Math.max(1, Math.round(raw * 10) / 10)) : 0;

  return {
    score,
    components: {
      technical: inputs.technicalScore,
      option: inputs.optionScore,
      regime: inputs.regimeConfidence,
    },
  };
}
