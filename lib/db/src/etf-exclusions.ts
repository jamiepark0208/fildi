/**
 * ETFs / levered products must never enter stock-vs-stock peer cohorts or
 * fundamental relative scoring. Single source of truth for seed + API runtime.
 */
export const ETF_EXCLUSIONS = new Set([
  // Broad / sector
  "SMH", "SOXX", "IWM", "QQQ", "SPY", "ARKG", "CANE",
  // Credit / structured
  "BIZD", "JBBB",
  // Single-stock / thematic levered & wrappers
  "NVDY", "SPCK", "PSUS", "HOOY",
  // Memory thematic ETF
  "DRAM",
]);

export function isExcludedEtf(ticker: string): boolean {
  return ETF_EXCLUSIONS.has(ticker.trim().toUpperCase());
}
