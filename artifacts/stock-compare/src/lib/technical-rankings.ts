export interface IndicatorResult {
  ticker: string;
  scoredDate: string;
  rsi: number;
  rsiYesterday?: number;
  mfi: number;
  rsiThreshold: number;
  mfiThreshold: number;
  rsiOk: boolean;
  mfiOk: boolean;
  signal: "GO" | "WATCH" | "NO";
  tier: 1 | 2 | 3;
  atr: number | null;
  macdCross: "BULLISH_CROSS" | "BEARISH_CROSS" | "BULLISH" | "BEARISH" | null;
  stoch: number | null;
  return5d: number | null;
  position52w: number | null;
  vsSpy20d: number | null;
  earningsDate: string | null;
  price?: number;
  ivCurrent?: number;
  ivPercentile?: number;
  ma200?: number | null;
  stale?: boolean;
}

type TechnicalMetricDef = {
  key: string;
  label: string;
  weight: number;
  higherIsBetter: boolean;
  getValue: (d: IndicatorResult) => number | null;
};

export const TECHNICAL_SCORECARD_METRICS: TechnicalMetricDef[] = [
  { key: "signal",   label: "Signal",         weight: 3.0, higherIsBetter: true,  getValue: d => d.signal === "GO" ? 2 : d.signal === "WATCH" ? 1 : 0 },
  { key: "rsi",      label: "RSI 14",         weight: 3.0, higherIsBetter: true,  getValue: d => {
    const rsiScore = Math.max(0, Math.min(15, 15 * (1 - (d.rsi - d.rsiThreshold) / 20)));
    const rsiYesterday = d.rsiYesterday ?? d.rsi;
    const drop = rsiYesterday - d.rsi;
    const pctCovered = drop > 0 ? Math.max(0, Math.min(1, drop / rsiYesterday)) : 0;
    const velocityBonus = Math.max(0, Math.min(5, pctCovered * 5));
    return Math.min(15, rsiScore + velocityBonus);
  } },
  { key: "mfi",      label: "MFI 14",         weight: 2.5, higherIsBetter: true,  getValue: d => Math.max(0, Math.min(10, 10 * (1 - (d.mfi - 25) / 20))) },
  { key: "macd",     label: "MACD",           weight: 2.0, higherIsBetter: true,  getValue: d => d.macdCross === "BULLISH_CROSS" ? 3 : d.macdCross === "BULLISH" ? 2 : d.macdCross === "BEARISH" ? 1 : d.macdCross === "BEARISH_CROSS" ? 0 : null },
  { key: "pos52w",   label: "52w Position",   weight: 2.0, higherIsBetter: false, getValue: d => d.position52w },
  { key: "return5d", label: "5d Return",      weight: 1.5, higherIsBetter: true,  getValue: d => d.return5d !== null ? Math.max(0, Math.min(15, 7.5 - d.return5d * 100 * 1.5)) : null },
  { key: "vsSpy",    label: "vs SPY 20d",     weight: 1.5, higherIsBetter: false, getValue: d => d.vsSpy20d },
  { key: "stoch",    label: "Stochastic %K",  weight: 1.5, higherIsBetter: false, getValue: d => d.stoch },
  { key: "ivRank",      label: "IV rank",      weight: 8.0, higherIsBetter: true,  getValue: d => {
    if (d.ivCurrent == null || d.ivPercentile == null) return null;
    const absoluteScore = Math.max(0, Math.min(6, (d.ivCurrent - 20) / 80 * 6));
    const relativeScore = Math.max(0, Math.min(10, d.ivPercentile / 10));
    return absoluteScore + relativeScore;
  } },
  { key: "ma200Buffer", label: "MA200 buffer", weight: 5.0, higherIsBetter: true,  getValue: d => {
    if (!d.ma200 || !d.price) return null;
    const minOTM = d.tier === 1 ? 0.05 : d.tier === 2 ? 0.10 : 0.15;
    const impliedStrike = d.price * (1 - minOTM);
    const bufferPct = (d.ma200 - impliedStrike) / d.price;
    return Math.max(0, Math.min(10, bufferPct * 100));
  } },
];

export type TechnicalScore = {
  ticker: string;
  totalScore: number;
  maxPossible: number;
  rank: number;
  signal: "GO" | "WATCH" | "NO";
  tier: 1 | 2 | 3;
  metricScores: Record<string, { value: number | null; weightedScore: number; rank: number }>;
  reason: string;
};

function generateTechnicalReason(d: IndicatorResult): string {
  const parts: string[] = [];

  if (d.signal === "GO") {
    parts.push(`GO — RSI ${d.rsi.toFixed(1)} < ${d.rsiThreshold} & MFI ${d.mfi.toFixed(1)} < 25`);
  } else if (d.signal === "WATCH") {
    const rsiPart = d.rsiOk ? `RSI ${d.rsi.toFixed(1)} ✓` : `RSI ${d.rsi.toFixed(1)} vs ${d.rsiThreshold}`;
    const mfiPart = d.mfiOk ? `MFI ${d.mfi.toFixed(1)} ✓` : `MFI ${d.mfi.toFixed(1)} vs 25`;
    parts.push(`WATCH — ${rsiPart}, ${mfiPart}`);
  } else {
    const issues: string[] = [];
    if (!d.rsiOk) issues.push(`RSI ${d.rsi.toFixed(1)} > ${d.rsiThreshold}`);
    if (!d.mfiOk) issues.push(`MFI ${d.mfi.toFixed(1)} > 25`);
    parts.push(`NO — ${issues.join(" & ") || "conditions not met"}`);
  }

  if (d.macdCross === "BULLISH_CROSS") parts.push("MACD bullish crossover");
  else if (d.macdCross === "BEARISH_CROSS") parts.push("MACD bearish crossover");

  if (d.position52w != null) {
    if (d.position52w < 25) parts.push(`near 52w low (${d.position52w.toFixed(0)}%)`);
    else if (d.position52w > 75) parts.push(`near 52w high (${d.position52w.toFixed(0)}%)`);
  }

  return parts.join(" · ");
}

export function computeTechnicalRankings(stocks: IndicatorResult[]): TechnicalScore[] {
  if (stocks.length === 0) return [];

  const metricScores: Record<string, number[]> = {};

  for (const metric of TECHNICAL_SCORECARD_METRICS) {
    const values = stocks.map(s => metric.getValue(s));
    const nonNull = values
      .map((v, i) => ({ v: v!, i }))
      .filter(x => x.v !== null && x.v !== undefined && isFinite(x.v));

    nonNull.sort((a, b) => metric.higherIsBetter ? b.v - a.v : a.v - b.v);

    const scores = new Array(stocks.length).fill(0);
    nonNull.forEach((item, rankIdx) => {
      scores[item.i] = nonNull.length > 1 ? (nonNull.length - 1 - rankIdx) / (nonNull.length - 1) : 1;
    });
    metricScores[metric.key] = scores;
  }

  const totals = stocks.map((_, i) =>
    TECHNICAL_SCORECARD_METRICS.reduce((sum, m) => sum + (metricScores[m.key][i] ?? 0) * m.weight, 0)
  );
  const maxPossible = TECHNICAL_SCORECARD_METRICS.reduce((s, m) => s + m.weight, 0);

  const ranked = totals
    .map((score, i) => ({ i, score }))
    .sort((a, b) => b.score - a.score);

  return ranked.map((r, rankIdx) => {
    const s = stocks[r.i];
    const ms: TechnicalScore["metricScores"] = {};
    for (const m of TECHNICAL_SCORECARD_METRICS) {
      const normArr = metricScores[m.key];
      ms[m.key] = {
        value: m.getValue(s) ?? null,
        weightedScore: (normArr[r.i] ?? 0) * m.weight,
        rank: [...normArr].sort((a, b) => b - a).indexOf(normArr[r.i]) + 1,
      };
    }
    return {
      ticker: s.ticker,
      totalScore: parseFloat(totals[r.i].toFixed(2)),
      maxPossible,
      rank: rankIdx + 1,
      signal: s.signal,
      tier: s.tier,
      metricScores: ms,
      reason: generateTechnicalReason(s),
    };
  });
}
