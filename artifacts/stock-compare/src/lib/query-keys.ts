// Shared React Query keys for data fetched from more than one page.
// Keeping these in one place means Home and Scanner hit the same cache
// entry for fundamentals rankings instead of double-fetching (enh/34 T-B1).
export const queryKeys = {
  fundamentalsRankings: ["fundamentals-rankings"] as const,
  /** Full enriched rows — Technical / Rankings pages (client V2 scorer UI). */
  technicalsAll: ["technicals", "all"] as const,
  /** StockContext / relativeMove fields only — Options + Live. */
  technicalsAllSlim: ["technicals", "all", "slim"] as const,
  /** Side-aware V2 totals from API (put|call) — avoids shipping full rows to score. */
  technicalsRankings: (side: "put" | "call") => ["technicals", "rankings", side] as const,
  optionsRankings: (side: "put" | "call") => ["options-rankings", side] as const,
  optionsBatch: (tickersKey: string) => ["options-batch", tickersKey] as const,
};
