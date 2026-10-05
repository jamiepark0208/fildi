/**
 * Canonical on-demand fundamentals path: bronze fetch → populate → merge-trusted gold.
 *
 * All interactive / startup refreshes must go through here (or nightly-enrichment).
 * Never write ticker_fundamentals from a single-source waterfall (legacy SDM).
 */
import { inArray } from "drizzle-orm";
import { db, tickerFundamentals, tickerRegistry } from "@workspace/db";
import {
  FREE_ENRICH_SOURCES,
  type EnrichSource,
} from "./data-ops-config.js";
import { enrichmentRunning, setEnrichmentRunning } from "./scheduler.js";
import { FETCH_FN } from "../scripts/nightly-enrichment.js";
import { runPopulateSourceFundamentals } from "../scripts/populate-source-fundamentals.js";
import { runMergeTrusted } from "../scripts/merge-trusted.js";
import { classifyTicker } from "./peer-classifier.js";
import { isExcludedEtf } from "./etf-exclusions.js";
import { logger } from "./logger.js";

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

export type EnrichAndMergeResult = {
  ok: boolean;
  tickers: string[];
  sourcesTried: string[];
  fetched: number;
  failed: number;
  skipped: boolean;
  reason?: string;
  fromCache?: boolean;
};

/**
 * Flag tickers for fundamentals, fetch free sources (Yahoo first by default),
 * then populate + merge so gold + provenance stay authoritative.
 *
 * Defaults to FREE_ENRICH_SOURCES — scarce FMP/AV are nightly/cohort only.
 * Merge-trusted is priority-first (sources do not overwrite each other in gold);
 * extra fetches only waste quota into bronze/source_fundamentals.
 */
export async function enrichAndMergeTickers(
  tickers: string[],
  opts: {
    sources?: EnrichSource[];
    /** When true (default), refuse if nightly/queue already running. */
    respectMutex?: boolean;
  } = {},
): Promise<EnrichAndMergeResult> {
  const unique = [...new Set(tickers.map((t) => t.toUpperCase()).filter(Boolean))];
  if (unique.length === 0) {
    return {
      ok: true,
      tickers: [],
      sourcesTried: [],
      fetched: 0,
      failed: 0,
      skipped: true,
      reason: "no tickers",
    };
  }

  const respectMutex = opts.respectMutex !== false;
  if (respectMutex && enrichmentRunning) {
    return {
      ok: false,
      tickers: unique,
      sourcesTried: [],
      fetched: 0,
      failed: 0,
      skipped: true,
      reason: "enrichment already running",
    };
  }

  const sources = (opts.sources ?? [...FREE_ENRICH_SOURCES]).filter((s) => s in FETCH_FN);

  if (respectMutex) setEnrichmentRunning(true);
  let fetched = 0;
  let failed = 0;

  try {
    // Ensure registry rows exist and are flagged (scoped — no peer expansion here).
    for (const ticker of unique) {
      const etf = isExcludedEtf(ticker);
      await db
        .insert(tickerRegistry)
        .values({ ticker, isActive: true, fetchFundamentals: !etf })
        .onConflictDoUpdate({
          target: tickerRegistry.ticker,
          set: { fetchFundamentals: !etf },
        });
      if (etf) {
        logger.info({ ticker }, "enrich-and-merge: skipping ETF (no peer scoring / fundamentals flag)");
        continue;
      }
      // Auto-map into a peer group so sector scoring works without human PeerGroupEditor.
      try {
        const cls = await classifyTicker(ticker);
        if (cls.confidence === "unmapped") {
          logger.warn({ ticker }, "enrich-and-merge: ticker still unmapped after classify");
        }
      } catch (err) {
        logger.warn({ ticker, err }, "enrich-and-merge: peer classify failed");
      }
    }

    for (const source of sources) {
      const fn = FETCH_FN[source];
      if (!fn) continue;
      for (const ticker of unique) {
        if (isExcludedEtf(ticker)) continue;
        try {
          // Usage counted once inside client logApiCall — do not recordApiUsage here.
          const status = await fn(ticker);
          if (status === "ok") {
            fetched++;
          } else if (status === "fail") {
            failed++;
          }
        } catch (err) {
          failed++;
          logger.warn({ ticker, source, err }, "enrich-and-merge: fetch failed");
        }
        await sleep(source === "yahoo" ? 200 : 400);
      }
    }

    await runPopulateSourceFundamentals();
    await runMergeTrusted();

    logger.info(
      { tickers: unique, fetched, failed, sources },
      "enrich-and-merge: complete",
    );

    return {
      ok: true,
      tickers: unique,
      sourcesTried: sources,
      fetched,
      failed,
      skipped: false,
    };
  } catch (err) {
    logger.error({ err, tickers: unique }, "enrich-and-merge: failed");
    return {
      ok: false,
      tickers: unique,
      sourcesTried: sources,
      fetched,
      failed,
      skipped: false,
      reason: String((err as Error)?.message ?? err),
    };
  } finally {
    if (respectMutex) setEnrichmentRunning(false);
  }
}

/** Re-read gold after enrich (or return existing rows). */
export async function loadGoldFundamentals(tickers: string[]) {
  const upper = tickers.map((t) => t.toUpperCase());
  if (upper.length === 0) return [];
  return db
    .select()
    .from(tickerFundamentals)
    .where(inArray(tickerFundamentals.ticker, upper));
}
