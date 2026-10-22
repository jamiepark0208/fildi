/**
 * Ad-hoc watchlist add — make Breakdown usable in seconds, not after nightly.
 * Always: daily bars (chart) + live quote. Stocks: fund enrich. ETFs: skip stock enrich.
 */
import { logger } from "./logger.js";
import { ensureFreshOHLCV } from "./indicators.js";
import { getLivePrices } from "./live-quote.js";
import { enrichAndMergeTickers } from "./enrich-and-merge.js";

export async function warmWatchlistTicker(
  ticker: string,
  opts: { etf: boolean },
): Promise<void> {
  const t = ticker.trim().toUpperCase();
  if (!t) return;
  try {
    await Promise.all([
      ensureFreshOHLCV(t),
      getLivePrices([t]),
    ]);
  } catch (err) {
    logger.warn({ ticker: t, err }, "warm-watchlist: OHLCV/live failed");
  }

  if (!opts.etf) {
    try {
      const r = await enrichAndMergeTickers([t], { respectMutex: true });
      if (r.skipped) logger.warn({ ticker: t, reason: r.reason }, "warm-watchlist: enrich skipped");
      else logger.info({ ticker: t, fetched: r.fetched, failed: r.failed }, "warm-watchlist: enrich done");
    } catch (err) {
      logger.warn({ ticker: t, err }, "warm-watchlist: enrich failed");
    }
  } else {
    logger.info({ ticker: t }, "warm-watchlist: ETF — bars + live only (no stock fund enrich)");
  }
}
