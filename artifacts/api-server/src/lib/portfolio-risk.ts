import YahooFinanceClass from "yahoo-finance2";
import { historyCache } from "../routes/stocks.js";

const yahooFinance = new YahooFinanceClass();

// 1-day 95% parametric (variance-covariance) VaR/CVaR under a normal-returns
// assumption — standard closed-form constants, not fitted:
//   VaR95  = z(0.95)              * sigma = 1.645 * sigma
//   CVaR95 = phi(z(0.95)) / 0.05  * sigma = 2.063 * sigma
const Z_95 = 1.645;
const CVAR_95_MULT = 2.063;

async function fetchDailyCloses(ticker: string): Promise<number[]> {
  const key = `${ticker.toUpperCase()}_3M`;
  const cached = historyCache.get(key);
  if (cached) return (cached as Array<{ close: number }>).map(q => q.close);

  const result = await yahooFinance.chart(ticker.toUpperCase(), {
    period1: new Date(Date.now() - 90 * 24 * 60 * 60 * 1000),
    interval: "1d" as any,
  });
  const quotes = (result?.quotes ?? []).filter((q: any) => q.close != null);
  const data = quotes.map((q: any) => ({
    date: new Date(q.date).toISOString(), close: q.close,
    open: q.open ?? null, high: q.high ?? null, low: q.low ?? null, volume: q.volume ?? null,
  }));
  historyCache.set(key, data);
  return data.map(q => q.close);
}

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
  weight: number; // fraction of portfolio notional, need not sum to exactly 1
}

export interface PortfolioRiskResult {
  tickers: string[];
  correlationMatrix: number[][];
  dailyVolatilityPct: number;
  var95Pct: number;
  cvar95Pct: number;
  var95Usd: number;
  cvar95Usd: number;
  skippedTickers: string[]; // no usable price history (e.g. thinly-traded/new listing)
}

export async function computePortfolioRisk(
  positions: PortfolioRiskInput[],
  portfolioValueUsd: number,
): Promise<PortfolioRiskResult> {
  const uniqueTickers = [...new Set(positions.map(p => p.ticker.toUpperCase()))];
  const closesByTicker = new Map<string, number[]>();
  const skippedTickers: string[] = [];

  await Promise.all(uniqueTickers.map(async ticker => {
    try {
      const closes = await fetchDailyCloses(ticker);
      if (closes.length >= 10) closesByTicker.set(ticker, closes);
      else skippedTickers.push(ticker);
    } catch {
      skippedTickers.push(ticker);
    }
  }));

  const tickers = uniqueTickers.filter(t => closesByTicker.has(t));
  const returnsByTicker = new Map(tickers.map(t => [t, dailyReturns(closesByTicker.get(t)!)]));

  const correlationMatrix = tickers.map(a =>
    tickers.map(b => a === b ? 1 : parseFloat(pearsonCorrelation(returnsByTicker.get(a)!, returnsByTicker.get(b)!).toFixed(3)))
  );

  // Weights renormalized over tickers we actually have history for.
  const weightMap = new Map<string, number>();
  for (const p of positions) {
    if (!closesByTicker.has(p.ticker.toUpperCase())) continue;
    weightMap.set(p.ticker.toUpperCase(), (weightMap.get(p.ticker.toUpperCase()) ?? 0) + p.weight);
  }
  const weightSum = [...weightMap.values()].reduce((s, w) => s + w, 0);
  const w = (t: string) => weightSum > 0 ? (weightMap.get(t) ?? 0) / weightSum : 0;

  // Portfolio daily variance = w^T Σ w
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
    var95Usd: parseFloat((var95Pct / 100 * portfolioValueUsd).toFixed(2)),
    cvar95Usd: parseFloat((cvar95Pct / 100 * portfolioValueUsd).toFixed(2)),
    skippedTickers,
  };
}
