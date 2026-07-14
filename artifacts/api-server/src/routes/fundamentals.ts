import { Router } from "express";
import { requireAdmin } from "../middleware/requireAdmin.js";
import { requireAuth } from "../middleware/requireAuth.js";
import YahooFinanceClass from "yahoo-finance2";
import { getUnionWatchlistTickers } from "../lib/watchlist-tickers.js";
import { fetchFMPFundamentals } from "../lib/fmp-client.js";
import { writeFundamentalsRow, checkTriangulation, getStaleTickers, getAllFundamentalsStatus, checkFMPBudget, recordFMPCalls, getAllFundamentalsRows, computeAndPersistFundamentalScores, readPersistedScores } from "../lib/fundamentals-db.js";
import { getLatestRegime } from "./regime.js";
import { logger } from "../lib/logger.js";
import { StockDataManager, type HistoryCSVRow } from "../lib/stock-data-manager.js";
import { classifyTicker, type PeerGroupClassification } from "../lib/peer-classifier.js";
import { db, unmappedTickers, tickerRegistry, peerGroups, peerGroupMembers, tickerFundamentals, tickerTechnicals, indicatorCache } from "@workspace/db";
import { desc, inArray, sql } from "drizzle-orm";

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

  // Recompute and persist cross-sectional scores now that underlying metrics have changed
  try {
    const regime = await getLatestRegime();
    await computeAndPersistFundamentalScores(regime);
  } catch (err) {
    logger.warn({ err: String(err) }, "fundamentals: score recompute after refresh failed");
  }
}

async function refreshOneTicker(ticker: string, apiKey: string): Promise<void> {
  try {
    const fmpData = await fetchFMPFundamentals(ticker, apiKey, "fundamentals-refresh route");

    // Fetch Yahoo data for triangulation comparison only (not as primary source).
    let discrepancyFlags: string[] = [];
    let yahooBeta: number | null = null;
    try {
      const yahoo = await yahooFinance.quoteSummary(ticker.toUpperCase(), {
        modules: ["financialData", "defaultKeyStatistics"] as any,
      }, { validateResult: false });
      const yahooResult = yahoo as { financialData?: unknown; defaultKeyStatistics?: unknown };
      const yahooQuote = { ...(yahooResult.financialData ?? {}), ...(yahooResult.defaultKeyStatistics ?? {}) } as Record<string, unknown>;
      discrepancyFlags = checkTriangulation(fmpData, yahooQuote);
      if (yahooQuote["beta"] != null) yahooBeta = Number(yahooQuote["beta"]);
    } catch (err) {
      logger.warn({ ticker, err: String(err) }, "fundamentals: Yahoo triangulation fetch failed, skipping");
    }

    const regime = await getLatestRegime();
    const dataToWrite = fmpData.beta == null && yahooBeta !== null
      ? { ...fmpData, beta: yahooBeta }
      : fmpData;
    await writeFundamentalsRow(ticker, dataToWrite, discrepancyFlags, regime);
    if (fmpData.beta == null && yahooBeta !== null) {
      logger.debug({ ticker, yahooBeta }, "fundamentals: beta filled from Yahoo fallback");
    }
    logger.debug({ ticker }, "fundamentals: ticker refreshed");
  } catch (err: any) {
    logger.warn({ ticker, err: String(err?.message ?? err) }, "fundamentals: ticker refresh failed");
  }
}

// POST /fundamentals/refresh — refresh all 31 watchlist tickers from FMP.
// Checks daily API budget before starting. Returns 202 if budget allows, 429 if not.
router.post("/fundamentals/refresh", requireAdmin, async (_req, res) => {
  const unionTickers = await getUnionWatchlistTickers();
  const callsNeeded = unionTickers.length * 7;
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
  res.status(202).json({ message: "Fundamentals refresh started", tickers: unionTickers.length, budgetRemaining: budget.remaining });
  refreshFundamentals(unionTickers).catch(err =>
    logger.error({ err }, "fundamentals: background refresh crashed"),
  );
  return;
});

// POST /fundamentals/import-history — one-shot import of LSEG historical CSV rows.
// Body: { rows: HistoryCSVRow[] }
// Returns: { imported: number, skipped: number, errors: string[] }
router.post("/fundamentals/import-history", requireAdmin, async (req, res) => {
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
    const unionTickers = await getUnionWatchlistTickers();
    const summary = unionTickers.map(t => ({
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

// GET /fundamentals/rankings — fundamental quality score per watchlist ticker for Option Scorer.
// Computes a PUT_SELLER-aligned score using stored DB fields (no live price fetch needed).
// Cross-sectional percentile ranks each metric, then weights by quality/growth/safety families.
router.get("/fundamentals/rankings", async (_req, res) => {
  try {
    const regime = await getLatestRegime();

    // Serve persisted scores when fresh; recompute if stale or missing
    const cached = await readPersistedScores(regime);
    if (cached) return res.json(cached);

    const results = await computeAndPersistFundamentalScores(regime);
    return res.json(results);
  } catch (err: any) {
    return res.status(500).json({ error: String(err?.message ?? err) });
  }
});

// GET /fundamentals/peer-groups?tickers=AAPL,MSFT,...
// Resolves peer group classification for each ticker. Used by home.tsx to build
// peerGroupMap before calling computeRankingsV2.
router.get("/fundamentals/peer-groups", async (req, res) => {
  const tickerParam = req.query["tickers"];
  if (typeof tickerParam !== "string" || !tickerParam.trim()) {
    return res.status(400).json({ error: "tickers query param required" });
  }
  const tickers = tickerParam.split(",").map(t => t.trim().toUpperCase()).filter(Boolean);
  if (tickers.length === 0) return res.json({});

  try {
    const entries = await Promise.all(
      tickers.map(async t => {
        const result = await classifyTicker(t);
        return [t, result] as [string, PeerGroupClassification];
      }),
    );
    return res.json(Object.fromEntries(entries));
  } catch (err: any) {
    return res.status(500).json({ error: String(err?.message ?? err) });
  }
});

// GET /fundamentals/unmapped — admin only; returns tickers that failed peer-group classification.
// GET /fundamentals/stock-db — any signed-in user (view-only); every row in ticker_fundamentals.
// Shows all tickers we have data for, regardless of watchlist membership. Mutating actions
// (refresh, import-history, overrides) stay requireAdmin.
router.get("/fundamentals/stock-db", requireAuth, async (_req, res) => {
  try {
    const watchlistSet = new Set((await getUnionWatchlistTickers()).map((t: string) => t.toUpperCase()));

    const [fundRows, regRows, groupRows, techRows, signalResult] = await Promise.all([
      db.select().from(tickerFundamentals),
      db.select({ ticker: tickerRegistry.ticker, name: tickerRegistry.name, primaryPeerGroupId: tickerRegistry.primaryPeerGroupId }).from(tickerRegistry),
      db.select({ id: peerGroups.id, name: peerGroups.name }).from(peerGroups),
      db.select().from(tickerTechnicals),
      db.execute<{ ticker: string; signal: string }>(sql`
        SELECT DISTINCT ON (ticker) ticker, signal
        FROM indicator_cache
        ORDER BY ticker, scored_date DESC
      `),
    ]);

    const regByTicker    = new Map(regRows.map(r => [r.ticker.toUpperCase(), r]));
    const groupNameById  = new Map(groupRows.map(g => [g.id, g.name]));
    const techByTicker   = new Map(techRows.map(r => [r.ticker.toUpperCase(), r]));
    const signalByTicker = new Map(signalResult.rows.map(r => [r.ticker.toUpperCase(), r.signal]));

    const result = fundRows.map(row => {
      const reg     = regByTicker.get(row.ticker.toUpperCase());
      const groupId = reg?.primaryPeerGroupId ?? null;
      return {
        ticker:        row.ticker,
        companyName:   reg?.name ?? null,
        isWatchlist:   watchlistSet.has(row.ticker.toUpperCase()),
        peerGroupId:   groupId,
        peerGroupName: groupId ? (groupNameById.get(groupId) ?? null) : null,
        fundamentals:  row,
        technicals:    techByTicker.get(row.ticker.toUpperCase()) ?? null,
        signal:        signalByTicker.get(row.ticker.toUpperCase()) ?? null,
      };
    });

    result.sort((a, b) => a.ticker.localeCompare(b.ticker));
    return res.json(result);
  } catch (err: any) {
    return res.status(500).json({ error: String(err?.message ?? err) });
  }
});

router.get("/fundamentals/unmapped", requireAdmin, async (_req, res) => {
  try {
    const rows = await db
      .select()
      .from(unmappedTickers)
      .orderBy(desc(unmappedTickers.seenAt));
    return res.json(rows);
  } catch (err: any) {
    return res.status(500).json({ error: String(err?.message ?? err) });
  }
});

export default router;
