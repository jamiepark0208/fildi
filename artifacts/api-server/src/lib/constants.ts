export const RSI_THRESHOLDS: Record<string, number> = {
  // Tier 1 (>=92% win rate)
  NVDA: 45, INTC: 45, MRVL: 44, PLTR: 42, HOOD: 43, RDDT: 42,
  AAPL: 38, AMZN: 40, GOOGL: 40, TSLA: 42, NOW: 42,
  // Tier 2 (>=94% win rate)
  BABA: 38, SMCI: 40, SNOW: 40, AAOI: 42, NFLX: 38, NET: 40,
  OPEN: 35, ONDS: 35, POET: 35, SHOP: 40, FSLY: 35, RUM: 35,
  // Tier 3 (>=97% win rate)
  JOBY: 32, ACHR: 32, BB: 34, IONQ: 32, SOFI: 34, TTD: 36, RKLB: 32, RDW: 32,
};

export const MFI_THRESHOLD = 25;

export const TIER_CONFIG = {
  1: { rmFilter: 0.03,  minOTM: 0.05, maxOTM: 0.10, minIncome: 0.008 },
  2: { rmFilter: -0.02, minOTM: 0.10, maxOTM: 0.15, minIncome: 0.010 },
  3: { rmFilter: -0.02, minOTM: 0.15, maxOTM: 0.20, minIncome: 0.012 },
} as const;

const TIER_MAP: Record<string, 1 | 2 | 3> = {
  NVDA: 1, INTC: 1, MRVL: 1, PLTR: 1, HOOD: 1, RDDT: 1,
  AAPL: 1, AMZN: 1, GOOGL: 1, TSLA: 1, NOW: 1,
  BABA: 2, SMCI: 2, SNOW: 2, AAOI: 2, NFLX: 2, NET: 2,
  OPEN: 2, ONDS: 2, POET: 2, SHOP: 2, FSLY: 2, RUM: 2,
  JOBY: 3, ACHR: 3, BB: 3, IONQ: 3, SOFI: 3, TTD: 3, RKLB: 3, RDW: 3,
};

export function getTier(ticker: string): 1 | 2 | 3 {
  return TIER_MAP[ticker.toUpperCase()] ?? 2;
}

export const WATCHLIST = Object.keys(RSI_THRESHOLDS);
