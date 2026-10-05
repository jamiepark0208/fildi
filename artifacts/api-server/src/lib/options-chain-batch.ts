/**
 * Bounded concurrent Yahoo options-chain fetch shared by option-score snapshots
 * and model-track-record (avoids duplicated worker loops / Friday double pattern).
 */
import { getOptionsChain, type OptionsChainResult } from "./options.js";
import { logger } from "./logger.js";

const DEFAULT_CONCURRENCY = 3;

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

  const worker = async () => {
    while (idx < tickers.length) {
      const t = tickers[idx++]!;
      try {
        chainsByTicker.set(t, await getOptionsChain(t));
      } catch (err) {
        failures++;
        logger.warn({ err, ticker: t }, `${label}: chain fetch failed`);
      }
    }
  };

  if (tickers.length > 0) {
    await Promise.all(Array.from({ length: concurrency }, worker));
  }

  return { chainsByTicker, failures };
}
