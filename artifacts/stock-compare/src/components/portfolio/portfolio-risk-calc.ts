import {
  type PortfolioEntry, cashCollateral, premiumReceived,
  daysToExpiry, isShortPosition,
} from "@/hooks/use-portfolio";
import { isSameUnderlyingPair } from "./portfolio-palette";
import { type CoveredCallPair } from "./covered-calls-detector";
import { type AccountSummary, type PortfolioRiskResult } from "../portfolio-analysis";

// ── Margin usage ──────────────────────────────────────────────────────────────
// margin_used/buying_power are N/A (null) for cash-only accounts (e.g. the IRA) —
// only accounts actually trading on margin (e.g. FILDI) carry a value here.
export function computeMarginUsage(accountSummaries: AccountSummary[], activePortfolio: string) {
  const scopedSummaries = activePortfolio === "All"
    ? accountSummaries
    : accountSummaries.filter(a => (a.nickname ?? a.account) === activePortfolio);
  let marginUsed = 0, buyingPower = 0;
  scopedSummaries.forEach(a => {
    marginUsed  += parseFloat(a.marginUsed ?? "0");
    buyingPower += parseFloat(a.buyingPower ?? "0");
  });
  const capacity = marginUsed + buyingPower;
  return { marginUsed, buyingPower, pctUsed: capacity > 0 ? (marginUsed / capacity) * 100 : 0 };
}

// ── Concentration risk (HHI + top-5 tickers) ────────────────────────────────
// HHI on a standard 0-10,000 scale (sum of squared % weights, e.g. two tickers at
// 50% each = 5,000; fully diversified across many small positions → near 0).
export function computeConcentration(betaData: { ticker: string; weight: number }[]) {
  const weights = betaData.map(d => d.weight).sort((a, b) => b - a);
  const hhi = weights.reduce((s, w) => s + w * w, 0);
  const top5Pct = weights.slice(0, 5).reduce((s, w) => s + w, 0);
  const level: "Low" | "Moderate" | "High" = hhi < 1500 ? "Low" : hhi < 2500 ? "Moderate" : "High";
  return { hhi: Math.round(hhi), top5Pct, level, topTicker: betaData[0]?.ticker, topTickerPct: betaData[0]?.weight };
}

// ── Portfolio Greeks (Vega/Gamma exposure) ──────────────────────────────────
// Position-level sign flips for short options (selling a put/call means you're
// short that option's gamma/vega, i.e. exposure runs opposite the raw per-contract
// Greek) — same convention as the Delta/Theta banners elsewhere in this app.
export function computeGreeksExposure(filtered: PortfolioEntry[]) {
  let netVega = 0, netGamma = 0;
  for (const e of filtered) {
    if (e.positionType === "stock" || e.gamma == null && e.vega == null) continue;
    const sign = isShortPosition(e.positionType) ? -1 : 1;
    if (e.vega != null)  netVega  += e.vega  * 100 * e.qty * sign;
    if (e.gamma != null) netGamma += e.gamma * 100 * e.qty * sign;
  }
  return { netVega, netGamma };
}

// ── Correlation matrix scale bound ──────────────────────────────────────────
// Scale bound for the correlation heatmap — excludes the diagonal (always 1.00) and
// same-underlying pairs (mechanically ~1, would otherwise wash out real variation).
export function computeCorrelationScaleMax(portfolioRisk: PortfolioRiskResult | undefined) {
  if (!portfolioRisk) return 1;
  let max = 0;
  portfolioRisk.tickers.forEach((rowTicker, i) => {
    portfolioRisk.correlationMatrix[i].forEach((v, j) => {
      if (i === j) return;
      if (isSameUnderlyingPair(rowTicker, portfolioRisk.tickers[j])) return;
      max = Math.max(max, Math.abs(v));
    });
  });
  return max > 0 ? max : 1;
}

// ── Risk metrics (theta, assignment risk, at-risk puts, option position health) ──
export type OptionRow = {
  id: string; ticker: string; positionType: string; strike: number; expiry: string;
  premium: number; breakEven: number; qty: number;
  currentPrice: number | null; moneyness: number | null;
  collateral: number | null;
};

export function computePortfolioRiskMetrics(
  betaData: { contribution: number }[],
  filtered: PortfolioEntry[],
  priceMap: Record<string, number | undefined>,
  coveredCalls: Map<string, CoveredCallPair>,
) {
  const weightedBeta = betaData.reduce((s, d) => s + d.contribution, 0);

  let premiumSum = 0, premiumDTE = 0, totalCollateral = 0;
  filtered.forEach(e => {
    if (isShortPosition(e.positionType) && e.expiry) {
      const dte = daysToExpiry(e.expiry);
      if (dte != null && dte > 0) {
        const prem = premiumReceived(e);
        premiumSum += prem;
        premiumDTE += dte * prem;
      }
    }
    if (e.positionType === "short_put") totalCollateral += cashCollateral(e);
  });

  const avgDTE     = premiumSum > 0 ? premiumDTE / premiumSum : 0;
  const dailyTheta = avgDTE > 0 ? premiumSum / avgDTE : 0;
  const maxAssign  = totalCollateral;
  const expiringSoon = filtered.filter(e => {
    const d = daysToExpiry(e.expiry);
    return d !== null && d >= 0 && d <= 7;
  }).length;

  // Annualized income yield on collateral deployed
  const incomeYield = totalCollateral > 0 && avgDTE > 0
    ? (premiumSum / totalCollateral) * (365 / avgDTE) * 100
    : 0;

  // Net portfolio delta (approximations: stock=1.0, short_put=-0.25, short_call=+0.30)
  let netDelta = 0;
  filtered.forEach(e => {
    if (e.positionType === "stock")       netDelta += e.qty * 1.0;
    else if (e.positionType === "short_put")  netDelta -= e.qty * 100 * 0.25;
    else if (e.positionType === "short_call") netDelta += e.qty * 100 * 0.30;
  });

  // At-risk short puts: current price within 8% above strike
  const atRiskPositions = filtered.filter(e => {
    if (e.positionType !== "short_put" || !e.strike) return false;
    const price = priceMap[e.ticker];
    return price !== undefined && price < e.strike * 1.08;
  });

  const putPositions: OptionRow[] = filtered
    .filter(e => (e.positionType === "short_put" || e.positionType === "long_put") && e.strike)
    .map(e => {
      const price = priceMap[e.ticker] ?? null;
      const breakEven = e.positionType === "short_put"
        ? e.strike! - e.avgPrice
        : e.strike! + e.avgPrice;
      return {
        id: e.id, ticker: e.ticker, positionType: e.positionType, expiry: e.expiry!,
        strike: e.strike!, premium: e.avgPrice, breakEven, qty: e.qty,
        currentPrice: price,
        moneyness: price ? ((price / e.strike!) - 1) * 100 : null,
        // Cash secured by the broker against assignment: strike × 100 × contracts.
        collateral: e.positionType === "short_put" ? e.strike! * 100 * e.qty : null,
      };
    })
    .sort((a, b) => (b.collateral ?? -1) - (a.collateral ?? -1));

  const callPositions: OptionRow[] = filtered
    .filter(e => (e.positionType === "short_call" || e.positionType === "long_call") && e.strike)
    .map(e => {
      const price = priceMap[e.ticker] ?? null;
      const breakEven = e.positionType === "short_call"
        ? e.strike! + e.avgPrice
        : e.strike! - e.avgPrice;
      return {
        id: e.id, ticker: e.ticker, positionType: e.positionType, expiry: e.expiry!,
        strike: e.strike!, premium: e.avgPrice, breakEven, qty: e.qty,
        currentPrice: price,
        // for calls: positive = ITM (bad for short, good for long)
        moneyness: price ? ((price / e.strike!) - 1) * 100 : null,
        // Covered-call risk is the underlying shares called away: mkt price × 100 × contracts.
        collateral: e.positionType === "short_call" && price !== null ? price * 100 * e.qty : null,
      };
    })
    .sort((a, b) => (b.collateral ?? -1) - (a.collateral ?? -1));

  return {
    weightedBeta, dailyTheta, maxAssign, expiringSoon, avgDTE,
    incomeYield, netDelta, atRiskPositions: atRiskPositions.length,
    putPositions, callPositions, coveredCallCount: coveredCalls.size,
  };
}
