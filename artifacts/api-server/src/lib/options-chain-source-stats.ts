/**
 * In-process counters: how often option chains were served from Schwab vs Yahoo fallback.
 * Exposed on Ops / ApiMonitor so we stop guessing quote source in chat.
 */
let schwabChains = 0;
let yahooChains = 0;

export function recordOptionsChainSource(source: "schwab" | "yahoo"): void {
  if (source === "schwab") schwabChains += 1;
  else yahooChains += 1;
}

export function getOptionsChainSourceStats(): {
  schwab: number;
  yahoo: number;
  total: number;
  schwabSharePct: number | null;
} {
  const total = schwabChains + yahooChains;
  return {
    schwab: schwabChains,
    yahoo: yahooChains,
    total,
    schwabSharePct: total > 0 ? Math.round((100 * schwabChains) / total) : null,
  };
}
