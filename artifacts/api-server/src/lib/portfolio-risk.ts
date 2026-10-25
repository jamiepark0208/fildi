/**
 * Correlation + parametric VaR/CVaR from local prices_historical (no Yahoo fan-out).
 * A257: date-join returns (no tail-slice mismatch); signed weights (shorts hedge).
 */
import { and, gte, inArray, isNotNull, asc } from "drizzle-orm";
import { db, pricesHistorical } from "@workspace/db";
import { etDateKey } from "./market-hours.js";

// 1-day 95% parametric (variance-covariance) VaR/CVaR under a normal-returns
// assumption — standard closed-form constants, not fitted:
//   VaR95  = z(0.95)              * sigma = 1.645 * sigma
//   CVaR95 = phi(z(0.95)) / 0.05  * sigma = 2.063 * sigma
const Z_95 = 1.645;
const CVAR_95_MULT = 2.063;
const LOOKBACK_DAYS = 100; // calendar ≈ 3mo trading
/** Need enough closes to form ≥ MIN_SHARED_RETURNS on a dense series. */
export const MIN_CLOSES = 61;
/** Skip corr/cov pair when fewer than this many date-aligned returns (A257). */
export const MIN_SHARED_RETURNS = 60;
/** Cap matrix size for UI readability / O(n²) cost — denser grid shows ~32 */
const MAX_TICKERS = 32;
/** Same haircut the beta card uses for covered-call stock delta. */
export const COVERED_CALL_WEIGHT_HAIRCUT = 0.70;

export type DatedClose = { date: string; close: number };

function mean(xs: number[]): number {
  return xs.reduce((s, x) => s + x, 0) / (xs.length || 1);
}

/** Successive date-aligned returns on the intersection of dates (sorted). */
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
    ra.push(shared[i]!.ca / shared[i - 1]!.ca - 1);
    rb.push(shared[i]!.cb / shared[i - 1]!.cb - 1);
  }
  return { ra, rb };
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

export interface PortfolioRiskInput {
  ticker: string;
  /** Signed exposure weight (percent or fraction). Short stock / short call → negative. */
  weight: number;
  /** Apply covered-call δ×0.70 haircut to this ticker's weight magnitude. */
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
  /** A257: underlying parametric VaR (not full option-book VaR). */
  varBasis?: "underlying";
}

async function loadDatedClosesFromDb(tickers: string[]): Promise<Map<string, DatedClose[]>> {
  const out = new Map<string, DatedClose[]>();
  if (tickers.length === 0) return out;
  // Trading-day cutoff (ET), not a UTC date slice (A257).
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

/** Pure core — tests call this with fixture closes. */
export function computePortfolioRiskFromCloses(
  positions: PortfolioRiskInput[],
  portfolioValueUsd: number,
  closesByTicker: Map<string, DatedClose[]>,
): PortfolioRiskResult {
  // Prefer heavier |weight| first when we cap the matrix. Keep sign when aggregating.
  const weightAgg = new Map<string, number>();
  const covered = new Set<string>();
  for (const p of positions) {
    const t = p.ticker.toUpperCase();
    let w = p.weight;
    if (p.coveredCall) {
      covered.add(t);
      w *= COVERED_CALL_WEIGHT_HAIRCUT;
    }
    weightAgg.set(t, (weightAgg.get(t) ?? 0) + w);
  }
  const ranked = [...weightAgg.entries()].sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]));
  const uniqueTickers = ranked.map(([t]) => t);

  const skippedTickers: string[] = [];
  const withHistory = uniqueTickers.filter((t) => {
    const n = closesByTicker.get(t)?.length ?? 0;
    if (n >= MIN_CLOSES) return true;
    skippedTickers.push(t);
    return false;
  });

  const tickers = withHistory.slice(0, MAX_TICKERS);
  for (const t of withHistory.slice(MAX_TICKERS)) skippedTickers.push(t);

  const correlationMatrix = tickers.map((a) =>
    tickers.map((b) => {
      if (a === b) return 1;
      const r = pearsonCorrelationAligned(closesByTicker.get(a)!, closesByTicker.get(b)!);
      return r == null ? 0 : parseFloat(r.toFixed(3));
    }),
  );

  // Signed weights — do not abs. Renormalize by gross (|w| sum).
  const weightMap = new Map<string, number>();
  for (const t of tickers) {
    if (!weightAgg.has(t)) continue;
    weightMap.set(t, weightAgg.get(t)!);
  }
  const gross = [...weightMap.values()].reduce((s, w) => s + Math.abs(w), 0);
  const w = (t: string) => (gross > 0 ? (weightMap.get(t) ?? 0) / gross : 0);

  let variance = 0;
  for (const a of tickers) {
    for (const b of tickers) {
      const cov = a === b
        ? covarianceAligned(closesByTicker.get(a)!, closesByTicker.get(a)!)
        : covarianceAligned(closesByTicker.get(a)!, closesByTicker.get(b)!);
      if (cov == null) continue; // pair under MIN_SHARED_RETURNS — skip, don't tail-slice
      variance += w(a) * w(b) * cov;
    }
  }
  const dailyVol = Math.sqrt(Math.max(0, variance));

  const var95Pct = Z_95 * dailyVol * 100;
  const cvar95Pct = CVAR_95_MULT * dailyVol * 100;

  return {
    tickers,
    correlationMatrix,
    dailyVolatilityPct: parseFloat((dailyVol * 100).toFixed(3)),
    var95Pct: parseFloat(var95Pct.toFixed(3)),
    cvar95Pct: parseFloat(cvar95Pct.toFixed(3)),
    var95Usd: parseFloat(((var95Pct / 100) * portfolioValueUsd).toFixed(2)),
    cvar95Usd: parseFloat(((cvar95Pct / 100) * portfolioValueUsd).toFixed(2)),
    skippedTickers,
    varBasis: "underlying",
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

  const closesByTicker = await loadDatedClosesFromDb(uniqueTickers);
  return computePortfolioRiskFromCloses(positions, portfolioValueUsd, closesByTicker);
}
