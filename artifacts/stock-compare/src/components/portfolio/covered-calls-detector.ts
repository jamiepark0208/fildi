import { type PortfolioEntry } from "@/hooks/use-portfolio";

// ── Covered call detection ────────────────────────────────────────────────────

export interface CoveredCallPair {
  ticker: string;
  stockShares: number;
  callContracts: number;
  coveredContracts: number;
  strikes: number[];
}

export function detectCoveredCalls(entries: PortfolioEntry[]): Map<string, CoveredCallPair> {
  const stockMap: Record<string, number>           = {};
  const callMap:  Record<string, PortfolioEntry[]> = {};

  entries.forEach(e => {
    if (e.positionType === "stock")       stockMap[e.ticker] = (stockMap[e.ticker] ?? 0) + e.qty;
    if (e.positionType === "short_call") {
      if (!callMap[e.ticker]) callMap[e.ticker] = [];
      callMap[e.ticker].push(e);
    }
  });

  const pairs = new Map<string, CoveredCallPair>();
  Object.entries(callMap).forEach(([ticker, calls]) => {
    const stockShares = stockMap[ticker] ?? 0;
    if (stockShares === 0) return;
    const callContracts    = calls.reduce((s, c) => s + c.qty, 0);
    const coveredContracts = Math.min(callContracts, Math.floor(stockShares / 100));
    if (coveredContracts > 0) {
      pairs.set(ticker, {
        ticker, stockShares, callContracts, coveredContracts,
        strikes: calls.map(c => c.strike ?? 0).filter(Boolean),
      });
    }
  });
  return pairs;
}
