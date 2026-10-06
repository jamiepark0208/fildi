import type { TickerFundamentalsRow, TickerTechnicalsRow } from "@workspace/db";
import { scoreTechnicalRowV2 } from "./technical-scorer-v2.js";
import { STALE_DAYS } from "./data-ops-config.js";
const STALE_HOURS = 23;

function n(v: string | null | undefined): number | null {
  if (v == null) return null;
  const x = parseFloat(v);
  return isFinite(x) ? x : null;
}

export function isFundamentalsStale(row: TickerFundamentalsRow | null): boolean {
  if (!row?.fundamentalsLastFetched) return true;
  const cutoff = Date.now() - STALE_DAYS * 24 * 60 * 60 * 1000;
  return row.fundamentalsLastFetched.getTime() < cutoff;
}

export function isTechnicalsStale(row: TickerTechnicalsRow | null): boolean {
  if (!row?.technicalsLastFetched) return true;
  const cutoff = Date.now() - STALE_HOURS * 60 * 60 * 1000;
  return row.technicalsLastFetched.getTime() < cutoff;
}

/** 50/50 tech+fund combined score [0,100]. */
export function computeTechFundScore(
  techTotalScore: number | null,
  fundTotalScore: number | null,
): number | null {
  const parts: Array<{ weight: number; score: number }> = [];
  if (techTotalScore != null && isFinite(techTotalScore)) {
    parts.push({ weight: 0.5, score: Math.max(0, Math.min(1, techTotalScore / 100)) });
  }
  if (fundTotalScore != null && isFinite(fundTotalScore)) {
    parts.push({ weight: 0.5, score: Math.max(0, Math.min(1, fundTotalScore / 100)) });
  }
  if (parts.length === 0) return null;
  const totalWeight = parts.reduce((s, p) => s + p.weight, 0);
  const combined = parts.reduce((s, p) => s + p.weight * p.score, 0) / totalWeight;
  return Math.round(combined * 1000) / 10;
}

type FundMetric = {
  key: string;
  weight: number;
  higherBetter: boolean;
  getValue: (r: TickerFundamentalsRow) => number | null;
};

const FUND_METRICS: FundMetric[] = [
  { key: "grossMargin",     weight: 2.0, higherBetter: true,  getValue: r => n(r.grossMargin) },
  { key: "operatingMargin", weight: 2.0, higherBetter: true,  getValue: r => n(r.operatingMargin) },
  { key: "netMargin",       weight: 3.0, higherBetter: true,  getValue: r => n(r.netMargin) },
  { key: "roe",             weight: 2.0, higherBetter: true,  getValue: r => n(r.returnOnEquity) },
  { key: "roicWacc",        weight: 1.5, higherBetter: true,  getValue: r => {
    const roic = n(r.roic); const wacc = n(r.wacc);
    return roic !== null && wacc !== null ? roic - wacc : null;
  }},
  { key: "revGrowth",       weight: 3.0, higherBetter: true,  getValue: r => n(r.revenueGrowthYoY) },
  { key: "epsGrowth",       weight: 3.0, higherBetter: true,  getValue: r => n(r.epsGrowth) },
  { key: "currentRatio",    weight: 1.5, higherBetter: true,  getValue: r => n(r.currentRatio) },
  { key: "debtToEquity",    weight: 1.0, higherBetter: false, getValue: r => n(r.debtToEquity) },
  { key: "intCoverage",     weight: 2.5, higherBetter: true,  getValue: r => {
    const ebit = n(r.ebit); const ie = n(r.interestExpense);
    return ebit !== null && ie !== null && ie > 0 ? ebit / ie : null;
  }},
  { key: "cashRunway",      weight: 3.0, higherBetter: true,  getValue: r => {
    const cash = n(r.cashAndEquivalents); const ocf = n(r.quarterlyOperatingCashFlow);
    return cash !== null && ocf !== null && ocf > 0 ? cash / (ocf * 4) : null;
  }},
];

export function computeFundScoresForRows(rows: TickerFundamentalsRow[]): Map<string, number> {
  const out = new Map<string, number>();
  if (rows.length === 0) return out;

  const values = FUND_METRICS.map(m => rows.map(r => m.getValue(r)));
  const pctRanks: (number | null)[][] = FUND_METRICS.map((m, mi) => {
    const vals = values[mi];
    const nonNull = vals.filter(v => v !== null) as number[];
    if (nonNull.length === 0) return vals.map(() => null);
    const sorted = [...nonNull].sort((a, b) => a - b);
    return vals.map(v => {
      if (v === null) return null;
      const idx = sorted.findIndex(s => s >= v);
      const pct = sorted.length === 1 ? 0.5 : idx / (sorted.length - 1);
      return m.higherBetter ? pct : 1 - pct;
    });
  });

  rows.forEach((row, ri) => {
    let weightedSum = 0;
    let totalWeight = 0;
    FUND_METRICS.forEach((m, mi) => {
      const pct = pctRanks[mi][ri];
      if (pct !== null) { weightedSum += pct * m.weight; totalWeight += m.weight; }
    });
    const totalScore = totalWeight > 0 ? (weightedSum / totalWeight) * 100 : 50;
    out.set(row.ticker.toUpperCase(), parseFloat(totalScore.toFixed(2)));
  });
  return out;
}

const METRIC_LABELS: Record<string, string> = {
  grossMargin: "Gross Margin", operatingMargin: "Operating Margin", netMargin: "Net Margin",
  roe: "ROE", roicWacc: "ROIC - WACC", revGrowth: "Revenue Growth", epsGrowth: "EPS Growth",
  currentRatio: "Current Ratio", debtToEquity: "Debt/Equity",
  intCoverage: "Interest Coverage", cashRunway: "Cash Runway (yrs)",
};

export interface FundMetricBreakdown {
  label: string;
  value: number;
  zScore: number;
}

/** Top metrics (by |z-score| vs the peer group) for a ticker's fundamentals — used for hover tooltips. */
export function computeFundMetricBreakdown(rows: TickerFundamentalsRow[], ticker: string): FundMetricBreakdown[] {
  const row = rows.find(r => r.ticker.toUpperCase() === ticker.toUpperCase());
  if (!row) return [];

  return FUND_METRICS.map((m): FundMetricBreakdown | null => {
    const vals = rows.map(r => m.getValue(r)).filter((v): v is number => v !== null);
    const val = m.getValue(row);
    if (val === null || vals.length < 2) return null;
    const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
    const std = Math.sqrt(vals.reduce((a, b) => a + (b - mean) ** 2, 0) / vals.length);
    const z = std > 0 ? (val - mean) / std : 0;
    return { label: METRIC_LABELS[m.key] ?? m.key, value: val, zScore: m.higherBetter ? z : -z };
  })
    .filter((x): x is FundMetricBreakdown => x !== null)
    .sort((a, b) => Math.abs(b.zScore) - Math.abs(a.zScore))
    .slice(0, 4);
}

export interface CompetitorRanked {
  rank: number;
  ticker: string;
  isSubject?: boolean;
  combinedScore: number | null;
  techScore: number | null;
  fundScore: number | null;
  fundValue: number | null;
  fundGrowth: number | null;
  fundQuality: number | null;
  fundSafety: number | null;
  pendingBackfill: boolean;
  breakdown: FundMetricBreakdown[];
}

function persistedFund(row: TickerFundamentalsRow | null | undefined): {
  total: number | null;
  value: number | null;
  growth: number | null;
  quality: number | null;
  safety: number | null;
} {
  if (!row) {
    return { total: null, value: null, growth: null, quality: null, safety: null };
  }
  return {
    total: n(row.fundTotalScore),
    value: n(row.fundValueScore),
    growth: n(row.fundGrowthScore),
    quality: n(row.fundQualityScore),
    safety: n(row.fundSafetyScore),
  };
}

export function rankCompetitors(
  subject: string,
  peerTickers: string[],
  techRows: TickerTechnicalsRow[],
  fundRows: TickerFundamentalsRow[],
  opts?: { limit?: number; includeSubject?: boolean },
): CompetitorRanked[] {
  const key = subject.toUpperCase();
  const limit = opts?.limit ?? 12;
  const includeSubject = opts?.includeSubject !== false;
  const techMap = new Map(techRows.map(r => [r.ticker.toUpperCase(), r]));
  const fundMap = new Map(fundRows.map(r => [r.ticker.toUpperCase(), r]));

  const universe = Array.from(new Set([key, ...peerTickers.map((t) => t.toUpperCase())]));

  const techScores = new Map<string, number>();
  for (const t of universe) {
    const row = techMap.get(t);
    if (row) {
      const s = scoreTechnicalRowV2(row);
      if (s != null) techScores.set(t, s);
    }
  }

  // Fallback peer-relative fund score only when persisted fund_* is missing
  const fallbackFund = computeFundScoresForRows(fundRows);

  const scored = universe.map((u) => {
    const techRow = techMap.get(u) ?? null;
    const fundRow = fundMap.get(u) ?? null;
    const techScore = techScores.get(u) ?? null;
    const pf = persistedFund(fundRow);
    const fundScore = pf.total ?? fallbackFund.get(u) ?? null;
    const pendingBackfill =
      isTechnicalsStale(techRow) || isFundamentalsStale(fundRow);
    return {
      ticker: u,
      isSubject: u === key,
      combinedScore: computeTechFundScore(techScore, fundScore),
      techScore,
      fundScore,
      fundValue: pf.value,
      fundGrowth: pf.growth,
      fundQuality: pf.quality,
      fundSafety: pf.safety,
      pendingBackfill,
      breakdown: computeFundMetricBreakdown(fundRows, u),
    };
  });

  const peers = scored
    .filter((s) => !s.isSubject)
    .sort((a, b) => {
      if (a.combinedScore == null && b.combinedScore == null) return 0;
      if (a.combinedScore == null) return 1;
      if (b.combinedScore == null) return -1;
      return b.combinedScore - a.combinedScore;
    })
    .slice(0, limit);

  const subjectRow = scored.find((s) => s.isSubject);
  const ordered = includeSubject && subjectRow ? [subjectRow, ...peers] : peers;
  return ordered.map((s, i) => ({ rank: i + 1, ...s }));
}
