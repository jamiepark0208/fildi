// Rule-based bull/bear bullets for the stock Breakdown (fallback when no desk/AI cases). Moved from routes/stocks.ts.
export function buildBullBullets(m: any): string[] {
  const out: string[] = [];
  if (m.revenueGrowthYoY != null && m.revenueGrowthYoY > 0.10)
    out.push(`Revenue growing ${(m.revenueGrowthYoY * 100).toFixed(0)}% YoY — above-average expansion`);
  if (m.epsGrowth != null && m.epsGrowth > 0.10)
    out.push(`EPS up ${(m.epsGrowth * 100).toFixed(0)}% — earnings momentum supports premium valuation`);
  if (m.netMargin != null && m.netMargin > 0.15)
    out.push(`${(m.netMargin * 100).toFixed(0)}% net margin signals durable pricing power`);
  if (m.returnOnEquity != null && m.returnOnEquity > 0.15)
    out.push(`ROE of ${(m.returnOnEquity * 100).toFixed(0)}% reflects efficient capital allocation`);
  if (m.freeCashFlow != null && m.freeCashFlow > 0)
    out.push("Positive free cash flow funds buybacks, dividends, or reinvestment without dilution");
  if (m.currentRatio != null && m.currentRatio > 1.5)
    out.push(`Current ratio ${m.currentRatio.toFixed(1)}x — near-term obligations comfortably covered`);
  if (m.analystTargetPrice != null && m.currentPrice != null && m.analystTargetPrice > m.currentPrice * 1.10)
    out.push(`Consensus target implies ${((m.analystTargetPrice / m.currentPrice - 1) * 100).toFixed(0)}%+ upside from current price`);
  return out.slice(0, 4);
}

export function buildBearBullets(m: any): string[] {
  const out: string[] = [];
  if (m.debtToEquity != null && m.debtToEquity > 1.5)
    out.push(`D/E of ${m.debtToEquity.toFixed(1)}x — elevated leverage amplifies downside in a downturn`);
  if (m.peRatio != null && m.peRatio > 30)
    out.push(`P/E of ${m.peRatio.toFixed(0)}x prices in high growth; any miss could reprice sharply`);
  if (m.pegRatio != null && m.pegRatio > 2)
    out.push(`PEG of ${m.pegRatio.toFixed(1)}x suggests stock is running ahead of its growth rate`);
  if (m.revenueGrowthYoY != null && m.revenueGrowthYoY < 0.05)
    out.push(`Revenue growth of ${(m.revenueGrowthYoY * 100).toFixed(0)}% points to slowing demand`);
  if (m.netMargin != null && m.netMargin < 0.05 && m.netMargin >= 0)
    out.push(`${(m.netMargin * 100).toFixed(1)}% net margin leaves little buffer against cost pressure`);
  if (m.freeCashFlow != null && m.freeCashFlow < 0)
    out.push("Negative free cash flow requires external financing to sustain operations");
  if (m.currentRatio != null && m.currentRatio < 1.0)
    out.push(`Current ratio below 1x raises near-term liquidity concerns`);
  return out.slice(0, 4);
}
