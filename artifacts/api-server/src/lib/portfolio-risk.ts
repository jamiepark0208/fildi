/**
 * Correlation + parametric VaR/CVaR from local prices_historical (no Yahoo fan-out).
 * Yahoo chart-per-ticker used to rate-limit and leave most names skipped → tiny matrices.
 */
import { and, gte, inArray, isNotNull, asc } from "drizzle-orm";
import { db, pricesHistorical } from "@workspace/db";

// 1-day 95% parametric (variance-covariance) VaR/CVaR under a normal-returns
// assumption — standard closed-form constants, not fitted:
//   VaR95  = z(0.95)              * sigma = 1.645 * sigma
//   CVaR95 = phi(z(0.95)) / 0.05  * sigma = 2.063 * sigma
const Z_95 = 1.645;
const CVAR_95_MULT = 2.063;
const LOOKBACK_DAYS = 100; // calendar ≈ 3mo trading
const MIN_CLOSES = 10;
/** Cap matrix size for UI readability / O(n²) cost — denser grid shows ~32 */
const MAX_TICKERS = 32;

function dailyReturns(closes: number[]): number[] {
  const out: number[] = [];
  for (let i = 1; i < closes.length; i++) out.push(closes[i] / closes[i - 1] - 1);
  return out;
}

function mean(xs: number[]): number {
  return xs.reduce((s, x) => s + x, 0) / (xs.length || 1);
}

function pearsonCorrelation(a: number[], b: number[]): number {
  const n = Math.min(a.length, b.length);
  if (n < 2) return 0;
  const ma = mean(a.slice(-n)), mb = mean(b.slice(-n));
  let cov = 0, va = 0, vb = 0;
  for (let i = 0; i < n; i++) {
    const da = a[a.length - n + i] - ma, db = b[b.length - n + i] - mb;
    cov += da * db; va += da * da; vb += db * db;
  }
  if (va === 0 || vb === 0) return 0;
  return cov / Math.sqrt(va * vb);
}

function covariance(a: number[], b: number[]): number {
  const n = Math.min(a.length, b.length);
  if (n < 2) return 0;
  const ma = mean(a.slice(-n)), mb = mean(b.slice(-n));
  let cov = 0;
  for (let i = 0; i < n; i++) cov += (a[a.length - n + i] - ma) * (b[b.length - n + i] - mb);
  return cov / (n - 1);
}

export interface PortfolioRiskInput {
  ticker: string;
  weight: number; // fraction or percent of portfolio notional — renormalized
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
}

async function loadClosesFromDb(tickers: string[]): Promise<Map<string, number[]>> {
  const out = new Map<string, number[]>();
  if (tickers.length === 0) return out;
  const cutoff = new Date(Date.now() - LOOKBACK_DAYS * 24 * 60 * 60 * 1000)
    .toISOString()
    .slice(0, 10);

  const rows = await db
    .select({
      ticker: pricesHistorical.ticker,
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
    if (!Number.isFinite(c)) continue;
    const arr = out.get(t) ?? [];
    arr.push(c);
    out.set(t, arr);
  }
  return out;
}

export async function computePortfolioRisk(
  positions: PortfolioRiskInput[],
  portfolioValueUsd: number,
): Promise<PortfolioRiskResult> {
  // Prefer heavier weights first when we cap the matrix.
  const weightAgg = new Map<string, number>();
  for (const p of positions) {
    const t = p.ticker.toUpperCase();
    weightAgg.set(t, (weightAgg.get(t) ?? 0) + Math.abs(p.weight));
  }
  const ranked = [...weightAgg.entries()].sort((a, b) => b[1] - a[1]);
  const uniqueTickers = ranked.map(([t]) => t);

  const closesByTicker = await loadClosesFromDb(uniqueTickers);
  const skippedTickers: string[] = [];
  const withHistory = uniqueTickers.filter((t) => {
    const n = closesByTicker.get(t)?.length ?? 0;
    if (n >= MIN_CLOSES) return true;
    skippedTickers.push(t);
    return false;
  });

  const tickers = withHistory.slice(0, MAX_TICKERS);
  for (const t of withHistory.slice(MAX_TICKERS)) skippedTickers.push(t);

  const returnsByTicker = new Map(tickers.map((t) => [t, dailyReturns(closesByTicker.get(t)!)]));

  const correlationMatrix = tickers.map((a) =>
    tickers.map((b) =>
      a === b
        ? 1
        : parseFloat(pearsonCorrelation(returnsByTicker.get(a)!, returnsByTicker.get(b)!).toFixed(3)),
    ),
  );

  const weightMap = new Map<string, number>();
  for (const p of positions) {
    const t = p.ticker.toUpperCase();
    if (!closesByTicker.has(t) || !tickers.includes(t)) continue;
    weightMap.set(t, (weightMap.get(t) ?? 0) + Math.abs(p.weight));
  }
  const weightSum = [...weightMap.values()].reduce((s, w) => s + w, 0);
  const w = (t: string) => (weightSum > 0 ? (weightMap.get(t) ?? 0) / weightSum : 0);

  let variance = 0;
  for (const a of tickers) {
    for (const b of tickers) {
      variance += w(a) * w(b) * covariance(returnsByTicker.get(a)!, returnsByTicker.get(b)!);
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
  };
}
