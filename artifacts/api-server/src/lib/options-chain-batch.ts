/**
 * Bounded concurrent Yahoo options-chain fetch shared by option-score snapshots
 * and model-track-record (avoids duplicated worker loops / Friday double pattern).
 */
import { getOptionsChain, type OptionsChainResult } from "./options.js";
import { recordOptionsChainSource } from "./options-chain-source-stats.js";
import { getLivePrices } from "./live-quote.js";
import { logger } from "./logger.js";
import { installSchwabUsageMeter } from "./schwab-usage-meter.js";
import { fetchScanChain } from "./unused-feeds.js";

const DEFAULT_CONCURRENCY = 3;

/**
 * A7: chain.spot from Yahoo options often sticks on the prior session close.
 * Overlay the golden-source live quote (Schwab → Yahoo) so OTM%/delta/stored
 * model_recs.spot match the same-session tape. Row meetsGate still used the
 * fetch-time spot band — acceptable; stamp + score math use the live spot.
 */
async function overlayLiveSpot(
  chainsByTicker: Map<string, OptionsChainResult[]>,
  label: string,
): Promise<void> {
  const tickers = [...chainsByTicker.keys()];
  if (tickers.length === 0) return;
  try {
    const live = await getLivePrices(tickers);
    let updated = 0;
    for (const [t, chains] of chainsByTicker) {
      const px = live.get(t)?.price;
      if (px == null || !(px > 0)) continue;
      const prev = chains[0]?.spot;
      if (prev != null && Math.abs(prev - px) < 0.005) continue;
      chainsByTicker.set(
        t,
        chains.map((c) => ({ ...c, spot: px })),
      );
      updated++;
    }
    if (updated > 0) {
      logger.info({ updated, of: tickers.length }, `${label}: overlaid live spot on chains (A7)`);
    }
  } catch (err) {
    logger.warn({ err }, `${label}: live spot overlay failed — keeping chain.spot`);
  }
}

export async function fetchChainsForTickers(
  tickers: string[],
  opts?: { concurrency?: number; logLabel?: string },
): Promise<{
  chainsByTicker: Map<string, OptionsChainResult[]>;
  failures: number;
}> {
  const concurrency = Math.min(opts?.concurrency ?? DEFAULT_CONCURRENCY, Math.max(1, tickers.length));
  const label = opts?.logLabel ?? "options-chain-batch";
  const chainsByTicker = new Map<string, OptionsChainResult[]>();
  let failures = 0;
  let idx = 0;
  installSchwabUsageMeter();

  const worker = async () => {
    while (idx < tickers.length) {
      const t = tickers[idx++]!;
      try {
        const listed = await fetchScanChain(t);
        if (listed?.length) {
          recordOptionsChainSource("schwab");
          chainsByTicker.set(t, listed);
        } else {
          chainsByTicker.set(t, await getOptionsChain(t));
        }
      } catch (err) {
        failures++;
        logger.warn({ err, ticker: t }, `${label}: chain fetch failed`);
      }
    }
  };

  if (tickers.length > 0) {
    await Promise.all(Array.from({ length: concurrency }, worker));
  }

  await overlayLiveSpot(chainsByTicker, label);

  return { chainsByTicker, failures };
}
