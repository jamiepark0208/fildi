/**
 * In-process counters: how often option chains were served from Schwab vs Yahoo fallback,
 * plus bid-quality failures (vendor returned contracts but zero live bids in the sell band).
 * Exposed on Ops / ApiMonitor so we stop guessing quote source in chat.
 */
let schwabChains = 0;
let yahooChains = 0;
/** Schwab served a chain but 0 live bids in 3–25% OTM band — unexpected DQ. */
let schwabZeroBid = 0;
/** Yahoo served a chain with 0 live bids — often after-hours / thin names. */
let yahooZeroBid = 0;

export function recordOptionsChainSource(source: "schwab" | "yahoo"): void {
  if (source === "schwab") schwabChains += 1;
  else yahooChains += 1;
}

/** Call after mapping a chain: in-band contracts with bid>0. */
export function recordOptionsChainBidQuality(
  source: "schwab" | "yahoo",
  inBand: number,
  withLiveBid: number,
): void {
  if (inBand <= 0) return;
  if (withLiveBid > 0) return;
  if (source === "schwab") schwabZeroBid += 1;
  else yahooZeroBid += 1;
}

export function getOptionsChainSourceStats(): {
  schwab: number;
  yahoo: number;
  total: number;
  schwabSharePct: number | null;
  schwabZeroBid: number;
  yahooZeroBid: number;
} {
  const total = schwabChains + yahooChains;
  return {
    schwab: schwabChains,
    yahoo: yahooChains,
    total,
    schwabSharePct: total > 0 ? Math.round((100 * schwabChains) / total) : null,
    schwabZeroBid,
    yahooZeroBid,
  };
}
