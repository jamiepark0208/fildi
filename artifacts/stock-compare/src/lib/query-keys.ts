// Shared React Query keys for data fetched from more than one page.
// Keeping these in one place means Home and Scanner hit the same cache
// entry for fundamentals rankings instead of double-fetching (enh/34 T-B1).
export const queryKeys = {
  fundamentalsRankings: ["fundamentals-rankings"] as const,
  technicalsAll: ["technicals", "all"] as const,
  optionsRankings: (side: "put" | "call") => ["options-rankings", side] as const,
  optionsBatch: (tickersKey: string) => ["options-batch", tickersKey] as const,
};
