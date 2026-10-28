/**
 * Correlation + parametric VaR/CVaR from local prices_historical (no Yahoo fan-out).
 * A257: date-join returns (no tail-slice mismatch); signed weights (shorts hedge);
 * thin-history proxy cov (ρ̄·σa·σb); never silent VaR 0 on non-empty book.
 */
import { and, gte, inArray, isNotNull, asc } from "drizzle-orm";
import { db, pricesHistorical } from "@workspace/db";
import { etDateKey } from "./market-hours.js";
import { logger } from "./logger.js";

const Z_95 = 1.645;
const CVAR_95_MULT = 2.063;
const LOOKBACK_DAYS = 100;
/** Own σ needs ≥ this many closes (≥20 returns). */
export const MIN_OWN_CLOSES = 21;
/** Full pairwise corr/cov needs ≥ this many date-aligned returns. */
export const MIN_SHARED_RETURNS = 60;
/** Legacy alias — prefer MIN_OWN_CLOSES for inclusion. */
export const MIN_CLOSES = MIN_OWN_CLOSES;
const MAX_TICKERS = 32;
/** Drop a return step when calendar gap between shared closes exceeds this (weekends OK). */
export const MAX_GAP_DAYS = 4;
export const COVERED_CALL_WEIGHT_HAIRCUT = 0.70;
const DEFAULT_RHO_BAR = 0.5;
const SPY_PROXY_MULT = 1.5;

export type DatedClose = { date: string; close: number };
export type RiskCoverage = "none" | "partial" | "full";

function mean(xs: number[]): number {
  return xs.reduce((s, x) => s + x, 0) / (xs.length || 1);
}

function daysBetween(a: string, b: string): number {
  const ms = Date.parse(b) - Date.parse(a);
  return Math.round(ms / 86_400_000);
}

/** Successive date-aligned returns on shared dates; skip steps with calendar gap > MAX_GAP_DAYS. */
export function alignReturns(
  a: DatedClose[],
  b: DatedClose[],
): { ra: number[]; rb: number[] } | null {
  const mapB = new Map(b.map((x) => [x.date.slice(0, 10), x.close]));
  const shared: { date: string; ca: number; cb: number }[] = [];
  for (const x of a) {
    const d = x.date.slice(0, 10);
    const cb = mapB.get(d);
    if (cb == null || !(x.close > 0) || !(cb > 0)) continue;
    shared.push({ date: d, ca: x.close, cb });
  }
  shared.sort((p, q) => (p.date < q.date ? -1 : p.date > q.date ? 1 : 0));
  if (shared.length < 2) return null;
  const ra: number[] = [];
  const rb: number[] = [];
  for (let i = 1; i < shared.length; i++) {
    const prev = shared[i - 1]!;
    const cur = shared[i]!;
    if (daysBetween(prev.date, cur.date) > MAX_GAP_DAYS) continue;
    ra.push(cur.ca / prev.ca - 1);
    rb.push(cur.cb / prev.cb - 1);
  }
  return ra.length > 0 ? { ra, rb } : null;
}

export function pearsonCorrelationAligned(a: DatedClose[], b: DatedClose[]): number | null {
  const aligned = alignReturns(a, b);
  if (!aligned || aligned.ra.length < MIN_SHARED_RETURNS) return null;
  const { ra, rb } = aligned;
  const n = ra.length;
  const ma = mean(ra), mb = mean(rb);
  let cov = 0, va = 0, vb = 0;
  for (let i = 0; i < n; i++) {
    const da = ra[i]! - ma, db = rb[i]! - mb;
    cov += da * db; va += da * da; vb += db * db;
  }
  if (va === 0 || vb === 0) return 0;
  return cov / Math.sqrt(va * vb);
}

export function covarianceAligned(a: DatedClose[], b: DatedClose[]): number | null {
  const aligned = alignReturns(a, b);
  if (!aligned || aligned.ra.length < MIN_SHARED_RETURNS) return null;
  const { ra, rb } = aligned;
  const n = ra.length;
  const ma = mean(ra), mb = mean(rb);
  let cov = 0;
  for (let i = 0; i < n; i++) cov += (ra[i]! - ma) * (rb[i]! - mb);
  return cov / (n - 1);
}

/** Sample σ of successive returns on one series (gap-aware vs itself). */
export function ownSigma(closes: DatedClose[]): number | null {
  const aligned = alignReturns(closes, closes);
  if (!aligned || aligned.ra.length < MIN_OWN_CLOSES - 1) return null;
  const { ra } = aligned;
  const m = mean(ra);
  let v = 0;
  for (const r of ra) v += (r - m) ** 2;
  const s = Math.sqrt(v / (ra.length - 1));
  return Number.isFinite(s) && s > 0 ? s : null;
}

export interface PortfolioRiskInput {
  ticker: string;
  /** Signed exposure weight. Short stock / short call → negative. */
  weight: number;
  coveredCall?: boolean;
}

export interface PortfolioRiskResult {
  tickers: string[];
  correlationMatrix: number[][];
  dailyVolatilityPct: number;
  var95Pct: number;
  cvar95Pct: number;
  var95Usd: number;
  cvar95Usd: number;
  skippedTickers: string[];
  varBasis?: "underlying";
  /** Names using SPY×1.5 or thin-history σ proxy. */
  varProxy?: string[];
  /** True when variance used diagonal+ρ̄ fallback after negative pairwise build. */
  varFallback?: boolean;
  coverage?: RiskCoverage;
  /** Share of gross weight that entered the VaR (incl. proxies). */
  pricedGrossPct?: number;
}

async function loadDatedClosesFromDb(tickers: string[]): Promise<Map<string, DatedClose[]>> {
  const out = new Map<string, DatedClose[]>();
  if (tickers.length === 0) return out;
  const today = etDateKey();
  const [y, m, d] = today.split("-").map(Number);
  const cutoffDt = new Date(Date.UTC(y!, m! - 1, d!));
  cutoffDt.setUTCDate(cutoffDt.getUTCDate() - LOOKBACK_DAYS);
  const cutoff = cutoffDt.toISOString().slice(0, 10);

  const rows = await db
    .select({
      ticker: pricesHistorical.ticker,
      date: pricesHistorical.date,
      close: pricesHistorical.close,
    })
    .from(pricesHistorical)
    .where(
      and(
        inArray(pricesHistorical.ticker, tickers),
        gte(pricesHistorical.date, cutoff),
        isNotNull(pricesHistorical.close),
      ),
    )
    .orderBy(asc(pricesHistorical.ticker), asc(pricesHistorical.date));

  for (const r of rows) {
    const t = String(r.ticker).toUpperCase();
    const c = Number(r.close);
    if (!Number.isFinite(c) || !(c > 0)) continue;
    const date = String(r.date).slice(0, 10);
    const arr = out.get(t) ?? [];
    arr.push({ date, close: c });
    out.set(t, arr);
  }
  return out;
}

function buildVariance(
  tickers: string[],
  w: (t: string) => number,
  covOf: (a: string, b: string) => number,
): number {
  let variance = 0;
  for (const a of tickers) {
    for (const b of tickers) {
      variance += w(a) * w(b) * covOf(a, b);
    }
  }
  return variance;
}

/** Pure core — tests call this with fixture closes. Pass spyCloses for thin-name σ proxy. */
export function computePortfolioRiskFromCloses(
  positions: PortfolioRiskInput[],
  portfolioValueUsd: number,
  closesByTicker: Map<string, DatedClose[]>,
  spyCloses?: DatedClose[] | null,
): PortfolioRiskResult {
  const weightAgg = new Map<string, number>();
  for (const p of positions) {
    const t = p.ticker.toUpperCase();
    let ww = p.weight;
    if (p.coveredCall) ww *= COVERED_CALL_WEIGHT_HAIRCUT;
    weightAgg.set(t, (weightAgg.get(t) ?? 0) + ww);
  }
  const ranked = [...weightAgg.entries()].sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]));
  const uniqueTickers = ranked.map(([t]) => t);
  const fullGross = [...weightAgg.values()].reduce((s, x) => s + Math.abs(x), 0);

  const skippedTickers: string[] = [];
  const varProxy: string[] = [];
  const sigma = new Map<string, number>();
  const spySig = spyCloses ? ownSigma(spyCloses) : null;

  for (const t of uniqueTickers) {
    const closes = closesByTicker.get(t);
    const s = closes ? ownSigma(closes) : null;
    if (s != null) {
      sigma.set(t, s);
      if ((closes?.length ?? 0) < MIN_SHARED_RETURNS + 1) varProxy.push(t);
    } else if (spySig != null) {
      sigma.set(t, spySig * SPY_PROXY_MULT);
      varProxy.push(t);
    } else {
      skippedTickers.push(t);
    }
  }

  const priced = uniqueTickers.filter((t) => sigma.has(t)).slice(0, MAX_TICKERS);
  for (const t of uniqueTickers.filter((x) => sigma.has(x)).slice(MAX_TICKERS)) {
    skippedTickers.push(t);
    sigma.delete(t);
  }

  const pricedGross = priced.reduce((s, t) => s + Math.abs(weightAgg.get(t) ?? 0), 0);
  const pricedGrossPct = fullGross > 0 ? parseFloat(((pricedGross / fullGross) * 100).toFixed(1)) : 0;
  let coverage: RiskCoverage = "none";
  if (priced.length === 0 || pricedGross <= 0) coverage = "none";
  else if (skippedTickers.length > 0 || pricedGross + 1e-9 < fullGross) coverage = "partial";
  else coverage = "full";

  if (coverage === "none") {
    return {
      tickers: [],
      correlationMatrix: [],
      dailyVolatilityPct: 0,
      var95Pct: 0,
      cvar95Pct: 0,
      var95Usd: 0,
      cvar95Usd: 0,
      skippedTickers: [...new Set([...skippedTickers, ...uniqueTickers])],
      varBasis: "underlying",
      varProxy: [],
      varFallback: false,
      coverage: "none",
      pricedGrossPct: 0,
    };
  }

  // Normalize by full gross (incl. uncovered) so dropping a name doesn't inflate the rest to 100%.
  const denom = fullGross > 0 ? fullGross : pricedGross;

  // Valid pairwise ρ (≥ MIN_SHARED_RETURNS) before proxies — mean → ρ̄
  const validRhos: number[] = [];
  for (let i = 0; i < priced.length; i++) {
    for (let j = i + 1; j < priced.length; j++) {
      const a = priced[i]!, b = priced[j]!;
      const ca = closesByTicker.get(a), cb = closesByTicker.get(b);
      if (!ca || !cb) continue;
      const r = pearsonCorrelationAligned(ca, cb);
      if (r != null) validRhos.push(r);
    }
  }
  const rhoBar = validRhos.length > 0 ? mean(validRhos) : DEFAULT_RHO_BAR;

  const correlationMatrix = priced.map((a) =>
    priced.map((b) => {
      if (a === b) return 1;
      const ca = closesByTicker.get(a), cb = closesByTicker.get(b);
      if (ca && cb) {
        const r = pearsonCorrelationAligned(ca, cb);
        if (r != null) return parseFloat(r.toFixed(3));
      }
      // Disjoint / thin: show ρ̄, not 0 (0 understated risk)
      return parseFloat(rhoBar.toFixed(3));
    }),
  );

  const w = (t: string) => (denom > 0 ? (weightAgg.get(t) ?? 0) / denom : 0);

  const covOf = (a: string, b: string): number => {
    if (a === b) {
      const s = sigma.get(a)!;
      return s * s;
    }
    const ca = closesByTicker.get(a), cb = closesByTicker.get(b);
    if (ca && cb) {
      const c = covarianceAligned(ca, cb);
      if (c != null) return c;
    }
    return rhoBar * sigma.get(a)! * sigma.get(b)!;
  };

  let variance = buildVariance(priced, w, covOf);
  let varFallback = false;
  if (!(variance >= 0) || !Number.isFinite(variance)) {
    logger.warn({ variance }, "portfolio VaR pairwise variance non-PSD — diagonal+ρ̄ fallback");
    varFallback = true;
    variance = buildVariance(priced, w, (a, b) =>
      a === b ? sigma.get(a)! ** 2 : rhoBar * sigma.get(a)! * sigma.get(b)!,
    );
    if (!(variance >= 0) || !Number.isFinite(variance)) {
      // Last resort: diagonal only
      variance = priced.reduce((s, t) => s + w(t) ** 2 * sigma.get(t)! ** 2, 0);
    }
  }

  const dailyVol = Math.sqrt(Math.max(0, variance));
  const var95Pct = Z_95 * dailyVol * 100;
  const cvar95Pct = CVAR_95_MULT * dailyVol * 100;

  return {
    tickers: priced,
    correlationMatrix,
    dailyVolatilityPct: parseFloat((dailyVol * 100).toFixed(3)),
    var95Pct: parseFloat(var95Pct.toFixed(3)),
    cvar95Pct: parseFloat(cvar95Pct.toFixed(3)),
    var95Usd: parseFloat(((var95Pct / 100) * portfolioValueUsd).toFixed(2)),
    cvar95Usd: parseFloat(((cvar95Pct / 100) * portfolioValueUsd).toFixed(2)),
    skippedTickers,
    varBasis: "underlying",
    varProxy: [...new Set(varProxy)].filter((t) => priced.includes(t)),
    varFallback,
    coverage,
    pricedGrossPct,
  };
}

export async function computePortfolioRisk(
  positions: PortfolioRiskInput[],
  portfolioValueUsd: number,
): Promise<PortfolioRiskResult> {
  const weightAgg = new Map<string, number>();
  for (const p of positions) {
    const t = p.ticker.toUpperCase();
    weightAgg.set(t, (weightAgg.get(t) ?? 0) + Math.abs(p.weight));
  }
  const uniqueTickers = [...weightAgg.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([t]) => t);

  const closesByTicker = await loadDatedClosesFromDb([...uniqueTickers, "SPY"]);
  const spy = closesByTicker.get("SPY") ?? null;
  return computePortfolioRiskFromCloses(positions, portfolioValueUsd, closesByTicker, spy);
}
