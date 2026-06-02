import { StockMetrics } from "@workspace/api-client-react";

export type MetricDef = {
  key: string;
  label: string;
  weight: number;
  higherIsBetter: boolean;
  getValue: (s: StockMetrics) => number | null | undefined;
};

export const SCORECARD_METRICS: MetricDef[] = [
  { key: "peg",      label: "PEG Ratio",              weight: 3.0, higherIsBetter: false, getValue: s => s.pegRatio },
  { key: "pfcf",     label: "Price / FCF",             weight: 3.0, higherIsBetter: false, getValue: s => (s.marketCap && s.freeCashFlow && s.freeCashFlow > 0) ? s.marketCap / s.freeCashFlow : null },
  { key: "upside",   label: "Analyst Upside",          weight: 2.5, higherIsBetter: true,  getValue: s => (s.analystTargetPrice && s.currentPrice) ? (s.analystTargetPrice / s.currentPrice) - 1 : null },
  { key: "pe",       label: "P/E Ratio",               weight: 2.0, higherIsBetter: false, getValue: s => (s.peRatio != null && s.peRatio > 0) ? s.peRatio : null },
  { key: "revgrow",  label: "Revenue Growth",          weight: 2.5, higherIsBetter: true,  getValue: s => s.revenueGrowthYoY },
  { key: "epsgrow",  label: "EPS Growth",              weight: 2.5, higherIsBetter: true,  getValue: s => s.epsGrowth },
  { key: "netmgn",   label: "Net Margin",              weight: 2.0, higherIsBetter: true,  getValue: s => s.netMargin },
  { key: "roe",      label: "Return on Equity",        weight: 2.0, higherIsBetter: true,  getValue: s => s.returnOnEquity },
  { key: "fcf",      label: "Free Cash Flow",          weight: 2.0, higherIsBetter: true,  getValue: s => s.freeCashFlow },
  { key: "grossmgn", label: "Gross Margin",            weight: 1.5, higherIsBetter: true,  getValue: s => s.grossMargin },
  { key: "de",       label: "Debt / Equity",           weight: 1.5, higherIsBetter: false, getValue: s => s.debtToEquity },
  { key: "cr",       label: "Current Ratio",           weight: 1.0, higherIsBetter: true,  getValue: s => s.currentRatio },
];

export type StockScore = {
  ticker: string;
  companyName: string;
  totalScore: number;
  maxPossible: number;
  rank: number;
  metricScores: Record<string, { value: number | null; weightedScore: number; rank: number }>;
  reason: string;
};

export function computeRankings(stocks: StockMetrics[]): StockScore[] {
  if (stocks.length === 0) return [];

  const metricScores: Record<string, number[]> = {};

  // For each metric, rank all stocks and assign 0–1 scores
  for (const metric of SCORECARD_METRICS) {
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

  // Compute total weighted scores
  const totals = stocks.map((_, i) =>
    SCORECARD_METRICS.reduce((sum, m) => sum + (metricScores[m.key][i] ?? 0) * m.weight, 0)
  );
  const maxPossible = SCORECARD_METRICS.reduce((s, m) => s + m.weight, 0);

  // Sort by score descending to assign ranks
  const ranked = totals
    .map((score, i) => ({ i, score }))
    .sort((a, b) => b.score - a.score);

  return ranked.map((r, rankIdx) => {
    const s = stocks[r.i];
    const ms: StockScore["metricScores"] = {};
    const normForStock: Record<string, number> = {};
    for (const m of SCORECARD_METRICS) {
      const norm = metricScores[m.key][r.i] ?? 0;
      normForStock[m.key] = norm;
      ms[m.key] = {
        value: m.getValue(s) ?? null,
        weightedScore: norm * m.weight,
        rank: [...metricScores[m.key]].sort((a, b) => b - a).indexOf(metricScores[m.key][r.i]) + 1,
      };
    }

    const sortedByNorm = SCORECARD_METRICS
      .map(m => ({ label: m.label, norm: normForStock[m.key] }))
      .sort((a, b) => b.norm - a.norm);
    const top = sortedByNorm.slice(0, 2).filter(m => m.norm >= 0.6).map(m => m.label);
    const weak = sortedByNorm.slice(-2).filter(m => m.norm <= 0.25).map(m => m.label);

    let reason: string;
    const parts: string[] = [];
    if (top.length > 0) parts.push(`Leads: ${top.join(" & ")}`);
    if (weak.length > 0) parts.push(`Lags: ${weak.join(" & ")}`);
    reason = parts.join(" · ") || (rankIdx === 0 ? "Tops peers on aggregate fundamentals" : "Competitive across most metrics");

    return {
      ticker: s.ticker,
      companyName: s.companyName,
      totalScore: parseFloat(r.score.toFixed(2)),
      maxPossible,
      rank: rankIdx + 1,
      metricScores: ms,
      reason,
    };
  });
}
