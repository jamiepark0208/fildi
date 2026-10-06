/**
 * Blended fair value — pure math (no DB). Loader/persistence: fair-value-snapshots.ts.
 *
 * Each applicable method "votes" a per-share value; votes are blended in log space with a
 * trimmed mean (drop 1 high + 1 low at ≥4 voters, else median). Methods are routed by
 * peer_groups.scoring_mode and respect the group's metric_exclusions. External estimates
 * (de-biased consensus target, StarMine intrinsic value) vote as equals.
 *
 * Why this shape (research/fair_value/FINDINGS.md): over 2020–26 no method or weighting
 * predicted 3–12-month peer-relative returns (all ICs ≤ 0, convergence slope ≈ 0), so
 * learned/accuracy weights have nothing to learn; the trimmed log-space blend was the most
 * robust to bad inputs (p95 shift 0.20 vs 1.22 for an arithmetic mean) and to assumption
 * changes. This is a valuation reference, not a timing signal.
 */

import { isExtendedCyclical } from "./fund-score-guards.js";

export type FvMethod =
  | "peerForwardPe" | "warrantedPe" | "grahamForward" | "ohlsonJuettner"
  | "dcfFcfe" | "peerEvEbitda" | "excessReturns" | "peerPffo";
export type FvExternal = "analystTarget" | "starmine";
export type FvVoterName = FvMethod | FvExternal;

export interface FairValueParams {
  methodsByMode: Record<string, FvMethod[]>;
  externalVoters: { analystTarget: boolean; starmine: boolean };
  analystBias: number;
  blend: "trimmed" | "median" | "geo";
  minVoters: number;
  peerStat: "median" | "harmonic";
  minPeers: number;
  growthCap: number;
  growthFloor: number;
  equityRiskPremium: number;
  terminalGrowth: number;
  costOfEquityClamp: [number, number];
  betaClamp: [number, number];
  confidence: { highMaxSpread: number; mediumMaxSpread: number; highMinVoters: number; mediumMinVoters: number };
  lowConfidenceModes: string[];
  /** Cyclicals (fund-score-guards isExtendedCyclical) cap here: backtest error 0.52 vs ~0.37 overall, and
   *  mid-cycle EPS normalization made it worse (research/fair_value/cyclical_test.py). */
  cyclicalMaxConfidence?: "high" | "medium" | "low";
  /** Value-trap flag: fair/price ≥ this AND 12-1 momentum below the universe median. Lab: Graham-gap IC −0.128
   *  (t −2.5) among bottom-half momentum vs +0.024 top half; difference t 3.4 (research/fair_value/hypothesis_tests.py). */
  valueTrapMinGap?: number;
}

/**
 * Code seed for the scorecard_params "fair_value" lane (fv-1.0.0). Display-only today — feeds no score.
 * Evidence for every choice: research/fair_value/FINDINGS.md (backtest 2020–26 + scenario runs).
 */
export const FAIR_VALUE_SEED: FairValueParams & { aaaYieldFallbackSpread: number } = {
  // Which internal methods vote, by peer_groups.scoring_mode. Unlisted modes use "standard".
  // Speculative / pre-revenue / crypto modes get no model value (analyst target is shown separately).
  methodsByMode: {
    standard: ["peerForwardPe", "warrantedPe", "grahamForward", "ohlsonJuettner", "dcfFcfe", "peerEvEbitda"],
    financial: ["peerForwardPe", "warrantedPe", "grahamForward", "ohlsonJuettner", "excessReturns"],
    insurance: ["peerForwardPe", "warrantedPe", "grahamForward", "ohlsonJuettner", "excessReturns"],
    financial_mixed: ["peerForwardPe", "warrantedPe", "grahamForward", "ohlsonJuettner", "excessReturns"],
    reit: ["peerPffo"],
    speculative_pre_revenue: [], pre_revenue_ok: [], speculative_ok: [], speculative_crypto: [],
  },
  externalVoters: { analystTarget: true, starmine: true },
  // Rolling 12-month optimism of consensus targets (implied − realized log return), 2020–26 sample.
  analystBias: 0.02,
  blend: "trimmed",          // log space; drop 1 high + 1 low when ≥4 voters, else median
  minVoters: 2,
  peerStat: "median",        // harmonic tested worse in the backtest
  minPeers: 5,
  growthCap: 0.20,
  growthFloor: 0.0,
  equityRiskPremium: 0.05,
  terminalGrowth: 0.025,
  costOfEquityClamp: [0.07, 0.14],
  betaClamp: [0.6, 2.0],
  aaaYieldFallbackSpread: 0.008, // AAA ≈ 10Y + 80bp when FRED AAA is unavailable
  confidence: { highMaxSpread: 0.30, mediumMaxSpread: 0.50, highMinVoters: 4, mediumMinVoters: 3 },
  lowConfidenceModes: ["chinese"],
  cyclicalMaxConfidence: "medium",
  valueTrapMinGap: 1.25,
};

export interface FvTickerInput {
  ticker: string;
  mode: string;                 // peer_groups.scoring_mode ('standard' when unknown)
  peerGroupId: string | null;
  metricExclusions: string[];   // peer_groups.metric_exclusions
  price: number | null;
  forwardEps: number | null;    // FY1 consensus
  eps2: number | null;          // FY2 consensus
  ltg: number | null;           // analyst long-term EPS growth, decimal
  trailingEps: number | null;
  revenueGrowth: number | null;
  fcf: number | null;           // levered FCF (OCF − capex) → discounted at cost of equity
  shares: number | null;
  totalDebt: number | null;
  cash: number | null;
  ebitda: number | null;
  equity: number | null;
  roe: number | null;
  beta: number | null;
  ffo: number | null;
  analystTarget: number | null;
  starminePriceToIntrinsic: number | null;
  /** close[t−21] / close[t−252] − 1 (lab mom_12_1 definition); null when < 1 year of closes. */
  momentum12_1?: number | null;
}

export interface FvMarket { riskFree: number; aaaYield: number }

export interface FvVote { name: FvVoterName; value: number; kept: boolean }

export interface FairValueResult {
  ticker: string;
  mode: string;
  price: number | null;
  fairValue: number | null;
  low: number | null;           // lowest kept vote
  high: number | null;          // highest kept vote
  priceToFair: number | null;
  confidence: "high" | "medium" | "low" | null;
  spread: number | null;        // stdev of log(vote/price) across all votes
  votes: FvVote[];
  impliedGrowth: number | null; // FCF growth the price implies (reverse DCF), standard modes only
  nullReason: string | null;
  cyclical: boolean;
  valueTrap: boolean;
}

const clamp = (x: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, x));
const pos = (x: number | null | undefined): x is number => x != null && Number.isFinite(x) && x > 0;
const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}
function stdev(xs: number[]): number {
  const m = mean(xs);
  return Math.sqrt(mean(xs.map((x) => (x - m) ** 2)));
}
const sectorOf = (t: FvTickerInput) => (t.peerGroupId ?? "unknown").split(".")[0]!;
const isFinancial = (t: FvTickerInput) => ["financial", "insurance", "financial_mixed"].includes(t.mode);
const isReit = (t: FvTickerInput) => t.mode === "reit";

export function shortGrowth(t: FvTickerInput): number | null {
  return pos(t.forwardEps) && pos(t.eps2) ? t.eps2 / t.forwardEps - 1 : null;
}

/** Long-run growth: mean of analyst LTG and FY1→FY2 growth; else FY0→FY1 and revenue growth; capped. */
export function longGrowth(t: FvTickerInput, p: FairValueParams): number | null {
  const primary = [t.ltg, shortGrowth(t)].filter((x): x is number => x != null && Number.isFinite(x));
  const cands = primary.length ? primary : [
    pos(t.forwardEps) && pos(t.trailingEps) ? t.forwardEps / t.trailingEps - 1 : null,
    t.revenueGrowth,
  ].filter((x): x is number => x != null && Number.isFinite(x));
  return cands.length ? clamp(mean(cands), p.growthFloor, p.growthCap) : null;
}

export function costOfEquity(t: FvTickerInput, m: FvMarket, p: FairValueParams): number {
  const beta = clamp(t.beta ?? 1, p.betaClamp[0], p.betaClamp[1]);
  return clamp(m.riskFree + beta * p.equityRiskPremium, p.costOfEquityClamp[0], p.costOfEquityClamp[1]);
}

/** 10-year levered-FCF DCF: growth fades linearly from g0 to terminal; discounted at cost of equity. */
export function dcfPerShare(fcf: number, shares: number, g0: number, k: number, tg: number): number {
  let f = fcf;
  let pv = 0;
  for (let y = 1; y <= 10; y++) {
    f *= 1 + g0 + (tg - g0) * ((y - 1) / 9);
    pv += f / (1 + k) ** y;
  }
  return (pv + (f * (1 + tg)) / (k - tg) / (1 + k) ** 10) / shares;
}

/** Reverse DCF: initial FCF growth that makes the DCF equal today's price (bisection), or null. */
export function impliedGrowth(t: FvTickerInput, m: FvMarket, p: FairValueParams): number | null {
  if (!pos(t.fcf) || !pos(t.shares) || !pos(t.price) || isFinancial(t) || isReit(t)) return null;
  const k = costOfEquity(t, m, p);
  const f = (g: number) => dcfPerShare(t.fcf!, t.shares!, g, k, p.terminalGrowth) - t.price!;
  let lo = -0.3, hi = 0.8;
  if (f(lo) > 0 || f(hi) < 0) return null;
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2;
    if (f(mid) > 0) hi = mid; else lo = mid;
  }
  return (lo + hi) / 2;
}

// ── Universe-level peer statistics (leave-self-out) ─────────────────────────

interface PeerStats {
  forwardPe: Map<string, number>;
  evEbitda: Map<string, number>;
  pffo: Map<string, number>;
  warrantedPe: Map<string, number>;
}

function peerStat(values: number[], how: "median" | "harmonic"): number {
  return how === "median" ? median(values) : values.length / values.reduce((a, v) => a + 1 / v, 0);
}

/** Peer-group statistic (≥ minPeers, excluding self), else the parent sector's. */
function leaveSelfOutPeers(
  inputs: FvTickerInput[], metric: (t: FvTickerInput) => number | null, p: FairValueParams,
): Map<string, number> {
  const byGroup = new Map<string, { t: string; v: number }[]>();
  const bySector = new Map<string, { t: string; v: number }[]>();
  for (const t of inputs) {
    const v = metric(t);
    if (v == null || !(v > 0 && v < 150)) continue;
    const g = t.peerGroupId ?? "unknown";
    if (!byGroup.has(g)) byGroup.set(g, []);
    byGroup.get(g)!.push({ t: t.ticker, v });
    const s = sectorOf(t);
    if (!bySector.has(s)) bySector.set(s, []);
    bySector.get(s)!.push({ t: t.ticker, v });
  }
  const out = new Map<string, number>();
  for (const t of inputs) {
    for (const pool of [byGroup.get(t.peerGroupId ?? "unknown") ?? [], bySector.get(sectorOf(t)) ?? []]) {
      const vals = pool.filter((x) => x.t !== t.ticker).map((x) => x.v);
      if (vals.length >= p.minPeers) { out.set(t.ticker, peerStat(vals, p.peerStat)); break; }
    }
  }
  return out;
}

/** Solve least squares via normal equations (small k) with a tiny ridge for stability. */
function ols(X: number[][], y: number[]): number[] | null {
  const k = X[0]?.length ?? 0;
  if (!k || X.length <= k) return null;
  const A = Array.from({ length: k }, () => new Array<number>(k + 1).fill(0));
  for (let r = 0; r < X.length; r++) {
    const x = X[r]!;
    for (let i = 0; i < k; i++) {
      A[i]![k]! += x[i]! * y[r]!;
      for (let j = 0; j < k; j++) A[i]![j]! += x[i]! * x[j]!;
    }
  }
  for (let i = 0; i < k; i++) A[i]![i]! += 1e-6;
  for (let c = 0; c < k; c++) {
    let piv = c;
    for (let r = c + 1; r < k; r++) if (Math.abs(A[r]![c]!) > Math.abs(A[piv]![c]!)) piv = r;
    if (Math.abs(A[piv]![c]!) < 1e-12) return null;
    [A[c], A[piv]] = [A[piv]!, A[c]!];
    for (let r = 0; r < k; r++) {
      if (r === c) continue;
      const f = A[r]![c]! / A[c]![c]!;
      for (let j = c; j <= k; j++) A[r]![j]! -= f * A[c]![j]!;
    }
  }
  return A.map((row, i) => row[k]! / row[i]!);
}

/**
 * "Warranted" forward P/E (Bhojraj & Lee 2002 style): cross-sectional regression of log forward
 * P/E on sector dummies + short and long growth; each ticker's fitted P/E excludes itself.
 */
function warrantedForwardPe(inputs: FvTickerInput[], p: FairValueParams): Map<string, number> {
  const rows = inputs.filter((t) => !isReit(t) && pos(t.price) && pos(t.forwardEps)
    && t.price! / t.forwardEps! < 150 && longGrowth(t, p) != null);
  const out = new Map<string, number>();
  if (rows.length < 30) return out;
  const sectors = [...new Set(rows.map(sectorOf))].sort();
  const feat = (t: FvTickerInput) => {
    const gl = longGrowth(t, p)!;
    const gsRaw = shortGrowth(t);
    const gs = gsRaw != null ? clamp(gsRaw, -0.5, 1) : gl;
    return [1, ...sectors.slice(1).map((s) => (sectorOf(t) === s ? 1 : 0)), gs, gl];
  };
  const X = rows.map(feat);
  const y = rows.map((t) => Math.log(t.price! / t.forwardEps!));
  rows.forEach((t, i) => {
    const b = ols(X.filter((_, j) => j !== i), y.filter((_, j) => j !== i));
    if (!b) return;
    const fitted = X[i]!.reduce((a, x, j) => a + x * b[j]!, 0);
    out.set(t.ticker, Math.exp(fitted));
  });
  return out;
}

export function buildPeerStats(inputs: FvTickerInput[], p: FairValueParams): PeerStats {
  const ev = (t: FvTickerInput) =>
    pos(t.price) && pos(t.shares) ? t.price * t.shares + (t.totalDebt ?? 0) - (t.cash ?? 0) : null;
  return {
    forwardPe: leaveSelfOutPeers(inputs, (t) =>
      !isReit(t) && pos(t.price) && pos(t.forwardEps) ? t.price / t.forwardEps : null, p),
    evEbitda: leaveSelfOutPeers(inputs, (t) => {
      const e = ev(t);
      return !isFinancial(t) && !isReit(t) && e != null && pos(t.ebitda) ? e / t.ebitda : null;
    }, p),
    pffo: leaveSelfOutPeers(inputs, (t) =>
      isReit(t) && pos(t.price) && pos(t.shares) && pos(t.ffo) ? (t.price * t.shares) / t.ffo : null, p),
    warrantedPe: warrantedForwardPe(inputs, p),
  };
}

// ── Methods ─────────────────────────────────────────────────────────────────

const METHOD_EXCLUSION_KEYS: Partial<Record<FvMethod, string[]>> = {
  peerForwardPe: ["pe_ratio", "fwdpe"],
  warrantedPe: ["pe_ratio", "fwdpe"],
  grahamForward: ["pe_ratio"],
  ohlsonJuettner: ["pe_ratio"],
  peerEvEbitda: ["ev_ebitda"],
  peerPffo: ["pffo", "p_ffo"],
};

export function methodValue(
  method: FvMethod, t: FvTickerInput, m: FvMarket, p: FairValueParams, peers: PeerStats,
): number | null {
  const fe = pos(t.forwardEps) ? t.forwardEps : null;
  switch (method) {
    case "peerForwardPe": {
      const pe = peers.forwardPe.get(t.ticker);
      return fe && pe ? fe * pe : null;
    }
    case "warrantedPe": {
      const pe = peers.warrantedPe.get(t.ticker);
      return fe && pe ? fe * pe : null;
    }
    case "grahamForward": {
      // Revised Graham: EPS × (8.5 + 2g) × 4.4 / AAA, on forward EPS and capped long-run growth.
      const g = longGrowth(t, p);
      if (!fe || g == null || !(m.aaaYield > 0)) return null;
      return (fe * (8.5 + 2 * g * 100) * 4.4) / (m.aaaYield * 100);
    }
    case "ohlsonJuettner": {
      // Abnormal-earnings-growth model on FY1/FY2: V = e1/k + e1·(gs − gl) / (k·(k − gl)).
      if (!fe || !pos(t.eps2)) return null;
      const k = costOfEquity(t, m, p);
      const gl = clamp(m.riskFree - 0.03, 0, 0.03);
      const gsInputs = [shortGrowth(t), t.ltg].filter((x): x is number => x != null && Number.isFinite(x));
      const gs = clamp(mean(gsInputs), 0, 0.30);
      return fe / k + (fe * (gs - gl)) / (k * (k - gl));
    }
    case "dcfFcfe": {
      if (!pos(t.fcf) || !pos(t.shares)) return null;
      const g0 = clamp(longGrowth(t, p) ?? 0.03, -0.10, p.growthCap);
      return dcfPerShare(t.fcf, t.shares, g0, costOfEquity(t, m, p), p.terminalGrowth);
    }
    case "peerEvEbitda": {
      const mult = peers.evEbitda.get(t.ticker);
      if (!mult || !pos(t.ebitda) || !pos(t.shares)) return null;
      return (mult * t.ebitda - (t.totalDebt ?? 0) + (t.cash ?? 0)) / t.shares;
    }
    case "excessReturns": {
      // Banks/insurers: BVps + (ROE − k)·BVps / (k − g), ROE clamped to a sustainable band.
      if (!pos(t.equity) || !pos(t.shares) || t.roe == null) return null;
      const bv = t.equity / t.shares;
      const k = costOfEquity(t, m, p);
      return bv + ((clamp(t.roe, -0.05, 0.25) - k) * bv) / (k - p.terminalGrowth);
    }
    case "peerPffo": {
      const mult = peers.pffo.get(t.ticker);
      return mult && pos(t.ffo) && pos(t.shares) ? (mult * t.ffo) / t.shares : null;
    }
  }
}

// ── Blend ───────────────────────────────────────────────────────────────────

/** Blend log(vote/price) values; returns the blended log ratio and which votes were kept. */
export function blendLogs(xs: number[], how: FairValueParams["blend"]): { value: number; kept: boolean[] } {
  if (how === "geo") return { value: mean(xs), kept: xs.map(() => true) };
  if (how === "trimmed" && xs.length >= 4) {
    const order = xs.map((x, i) => [x, i] as const).sort((a, b) => a[0] - b[0]);
    const drop = new Set([order[0]![1], order[order.length - 1]![1]]);
    const kept = xs.map((_, i) => !drop.has(i));
    return { value: mean(xs.filter((_, i) => kept[i])), kept };
  }
  // median (also trimmed with < 4 votes): kept = the vote(s) at the median
  const med = median(xs);
  const s = [...xs].sort((a, b) => a - b);
  const lo = s[(s.length - 1) >> 1]!, hi = s[s.length >> 1]!;
  return { value: med, kept: xs.map((x) => x >= lo && x <= hi) };
}

export function computeFairValues(
  inputs: FvTickerInput[], market: FvMarket, p: FairValueParams,
): FairValueResult[] {
  const peers = buildPeerStats(inputs, p);
  const moms = inputs.map((t) => t.momentum12_1).filter((x): x is number => x != null && Number.isFinite(x));
  const momMedian = moms.length >= 20 ? median(moms) : null;
  return inputs.map((t) => {
    const r = computeOne(t, market, p, peers);
    const looksCheap = r.fairValue != null && r.price != null && r.fairValue / r.price >= (p.valueTrapMinGap ?? Infinity);
    r.valueTrap = looksCheap && momMedian != null && t.momentum12_1 != null && t.momentum12_1 < momMedian;
    return r;
  });
}

function computeOne(t: FvTickerInput, m: FvMarket, p: FairValueParams, peers: PeerStats): FairValueResult {
  const base: FairValueResult = {
    ticker: t.ticker, mode: t.mode, price: t.price, fairValue: null, low: null, high: null,
    priceToFair: null, confidence: null, spread: null, votes: [], impliedGrowth: null, nullReason: null,
    cyclical: isExtendedCyclical({ scoringMode: t.mode, peerGroupId: t.peerGroupId }),
    valueTrap: false,
  };
  if (!pos(t.price)) return { ...base, nullReason: "no_price" };
  const methods = p.methodsByMode[t.mode] ?? p.methodsByMode["standard"] ?? [];
  if (methods.length === 0) return { ...base, nullReason: `mode_${t.mode}` };

  const excluded = new Set(t.metricExclusions.map((x) => x.toLowerCase()));
  const raw: { name: FvVoterName; value: number }[] = [];
  for (const meth of methods) {
    if ((METHOD_EXCLUSION_KEYS[meth] ?? []).some((k) => excluded.has(k))) continue;
    const v = methodValue(meth, t, m, p, peers);
    if (v != null && Number.isFinite(v) && v > 0) raw.push({ name: meth, value: v });
  }
  if (p.externalVoters.analystTarget && pos(t.analystTarget)) {
    raw.push({ name: "analystTarget", value: t.analystTarget * Math.exp(-p.analystBias) });
  }
  if (p.externalVoters.starmine && pos(t.starminePriceToIntrinsic)) {
    raw.push({ name: "starmine", value: t.price / t.starminePriceToIntrinsic });
  }
  const implied = impliedGrowth(t, m, p);
  if (raw.length < p.minVoters) {
    return { ...base, votes: raw.map((v) => ({ ...v, kept: false })), impliedGrowth: implied, nullReason: "too_few_votes" };
  }

  const logs = raw.map((v) => Math.log(v.value / t.price!));
  const { value, kept } = blendLogs(logs, p.blend);
  const fairValue = t.price * Math.exp(value);
  // Range: the votes left after trimming; below 4 votes nothing is trimmed, so span them all
  // (the median of 3 would otherwise collapse the range to a single point).
  const keptValues = raw.filter((_, i) => raw.length < 4 || kept[i]).map((v) => v.value);
  const spread = stdev(logs);
  const c = p.confidence;
  let confidence: FairValueResult["confidence"] =
    raw.length >= c.highMinVoters && spread <= c.highMaxSpread ? "high"
      : raw.length >= c.mediumMinVoters && spread <= c.mediumMaxSpread ? "medium" : "low";
  if (p.lowConfidenceModes.includes(t.mode)) confidence = "low";
  if (base.cyclical && p.cyclicalMaxConfidence) {
    const rank = { low: 0, medium: 1, high: 2 } as const;
    if (rank[confidence] > rank[p.cyclicalMaxConfidence]) confidence = p.cyclicalMaxConfidence;
  }

  return {
    ...base,
    fairValue: round2(fairValue),
    low: round2(Math.min(...keptValues)),
    high: round2(Math.max(...keptValues)),
    priceToFair: Math.round((t.price / fairValue) * 1000) / 1000,
    confidence,
    spread: Math.round(spread * 1000) / 1000,
    votes: raw.map((v, i) => ({ name: v.name, value: round2(v.value), kept: kept[i]! })),
    impliedGrowth: implied != null ? Math.round(implied * 1000) / 1000 : null,
  };
}

const round2 = (x: number) => Math.round(x * 100) / 100;
