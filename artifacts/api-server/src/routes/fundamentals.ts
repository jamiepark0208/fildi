import { Router } from "express";
import YahooFinanceClass from "yahoo-finance2";
import { WATCHLIST } from "../lib/constants.js";
import { fetchFMPFundamentals } from "../lib/fmp-client.js";
import { writeFundamentalsRow, checkTriangulation, getStaleTickers, getAllFundamentalsStatus, checkFMPBudget, recordFMPCalls } from "../lib/fundamentals-db.js";
import { logger } from "../lib/logger.js";
import { StockDataManager, type HistoryCSVRow } from "../lib/stock-data-manager.js";

const router = Router();
const yahooFinance = new YahooFinanceClass();

// Refresh FMP fundamentals for a list of tickers.
// Exported so index.ts can call it on startup for stale tickers.
export async function refreshFundamentals(tickers: string[]): Promise<void> {
  const apiKey = process.env["FMP_API_KEY"];
  if (!apiKey) {
    logger.warn("FMP_API_KEY not set — fundamentals refresh skipped");
    return;
  }

  logger.info({ count: tickers.length }, "fundamentals: starting refresh");

  // Process tickers in batches of 5 to avoid hammering FMP
  const CALLS_PER_TICKER = 7;
  const BATCH = 5;
  for (let i = 0; i < tickers.length; i += BATCH) {
    const batch = tickers.slice(i, i + BATCH);
    await Promise.all(batch.map(ticker => refreshOneTicker(ticker, apiKey)));
    await recordFMPCalls(batch.length * CALLS_PER_TICKER);
    // Small pause between batches to stay well within rate limits
    if (i + BATCH < tickers.length) {
      await new Promise(r => setTimeout(r, 500));
    }
  }

  logger.info({ count: tickers.length }, "fundamentals: refresh complete");
}

async function refreshOneTicker(ticker: string, apiKey: string): Promise<void> {
  try {
    const fmpData = await fetchFMPFundamentals(ticker, apiKey);

    // Fetch Yahoo data for triangulation comparison only (not as primary source).
    let discrepancyFlags: string[] = [];
    try {
      const yahoo = await yahooFinance.quoteSummary(ticker.toUpperCase(), {
        modules: ["financialData", "defaultKeyStatistics"] as any,
      }, { validateResult: false });
      const yahooResult = yahoo as { financialData?: unknown; defaultKeyStatistics?: unknown };
      const yahooQuote = { ...(yahooResult.financialData ?? {}), ...(yahooResult.defaultKeyStatistics ?? {}) } as Record<string, unknown>;
      discrepancyFlags = checkTriangulation(fmpData, yahooQuote);
    } catch (err) {
      logger.warn({ ticker, err: String(err) }, "fundamentals: Yahoo triangulation fetch failed, skipping");
    }

    await writeFundamentalsRow(ticker, fmpData, discrepancyFlags);
    // beta is not available from FMP stable/profile (rate-limited at scale). buildMetrics
    // falls back to Yahoo quote.beta. Log here so we know which tickers rely on Yahoo beta.
    if (fmpData.beta == null) {
      logger.debug({ ticker }, "fundamentals: beta null from FMP — will use Yahoo fallback");
    }
    logger.debug({ ticker }, "fundamentals: ticker refreshed");
  } catch (err: any) {
    logger.warn({ ticker, err: String(err?.message ?? err) }, "fundamentals: ticker refresh failed");
  }
}

// POST /fundamentals/refresh — refresh all 31 watchlist tickers from FMP.
// Checks daily API budget before starting. Returns 202 if budget allows, 429 if not.
router.post("/fundamentals/refresh", async (_req, res) => {
  const callsNeeded = WATCHLIST.length * 7;
  const budget = await checkFMPBudget(callsNeeded);
  if (!budget.allowed) {
    logger.warn({ callsNeeded, callsToday: budget.callsToday, remaining: budget.remaining },
      "fundamentals: FMP daily budget would be exceeded");
    return res.status(429).json({
      error: "FMP daily budget would be exceeded — try again tomorrow",
      callsNeeded,
      callsToday: budget.callsToday,
      remaining: budget.remaining,
    });
  }
  res.status(202).json({ message: "Fundamentals refresh started", tickers: WATCHLIST.length, budgetRemaining: budget.remaining });
  refreshFundamentals(WATCHLIST).catch(err =>
    logger.error({ err }, "fundamentals: background refresh crashed"),
  );
  return;
});

// POST /fundamentals/import-history — one-shot import of LSEG historical CSV rows.
// Body: { rows: HistoryCSVRow[] }
// Returns: { imported: number, skipped: number, errors: string[] }
router.post("/fundamentals/import-history", async (req, res) => {
  const { rows } = req.body as { rows?: unknown[] };
  if (!Array.isArray(rows)) {
    return res.status(400).json({ error: "body.rows must be an array" });
  }

  const sdm = new StockDataManager();
  let imported = 0;
  let skipped = 0;
  const errors: string[] = [];

  for (const row of rows) {
    if (typeof row !== "object" || row === null) {
      skipped++;
      continue;
    }
    const r = row as Record<string, unknown>;
    if (typeof r["ticker"] !== "string" || typeof r["year"] !== "number") {
      errors.push(`Invalid row — missing ticker or year: ${JSON.stringify(row)}`);
      skipped++;
      continue;
    }
    try {
      await sdm.importHistoryRow(r as unknown as HistoryCSVRow);
      imported++;
    } catch (err: any) {
      errors.push(`${r["ticker"]}/${r["year"]}: ${String(err?.message ?? err)}`);
      skipped++;
    }
  }

  return res.json({ imported, skipped, errors });
});

// GET /fundamentals/status — last fetched timestamp, coverage per ticker, and API budget.
router.get("/fundamentals/status", async (_req, res) => {
  try {
    const [status, budget] = await Promise.all([
      getAllFundamentalsStatus(),
      checkFMPBudget(0), // 0 additional calls — just read current state
    ]);
    const byTicker = Object.fromEntries(status.map(s => [s.ticker, s]));
    const summary = WATCHLIST.map(t => ({
      ticker:          t,
      lastFetched:     byTicker[t]?.lastFetched ?? null,
      coveragePct:     byTicker[t]?.coveragePct ?? null,
      discrepancyFlags: byTicker[t]?.discrepancyFlags ?? [],
    }));
    return res.json({
      tickers: summary,
      apiBudget: { callsToday: budget.callsToday, remaining: budget.remaining, maxDaily: 220 },
    });
  } catch (err: any) {
    return res.status(500).json({ error: String(err?.message ?? err) });
  }
});

export default router;
