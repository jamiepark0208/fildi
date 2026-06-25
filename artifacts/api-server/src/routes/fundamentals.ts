import { Router } from "express";
import { requireAdmin } from "../middleware/requireAdmin.js";
import YahooFinanceClass from "yahoo-finance2";
import { WATCHLIST } from "../lib/constants.js";
import { fetchFMPFundamentals } from "../lib/fmp-client.js";
import { writeFundamentalsRow, checkTriangulation, getStaleTickers, getAllFundamentalsStatus, checkFMPBudget, recordFMPCalls, getAllFundamentalsRows } from "../lib/fundamentals-db.js";
import { logger } from "../lib/logger.js";
import { StockDataManager, type HistoryCSVRow } from "../lib/stock-data-manager.js";
import { classifyTicker, type PeerGroupClassification } from "../lib/peer-classifier.js";
import { db, unmappedTickers, tickerRegistry, peerGroups } from "@workspace/db";
import { desc, inArray } from "drizzle-orm";

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
router.post("/fundamentals/refresh", requireAdmin, async (_req, res) => {
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

// GET /fundamentals/rankings — fundamental quality score per watchlist ticker for Option Scorer.
// Computes a PUT_SELLER-aligned score using stored DB fields (no live price fetch needed).
// Cross-sectional percentile ranks each metric, then weights by quality/growth/safety families.
router.get("/fundamentals/rankings", async (_req, res) => {
  try {
    const rows = await getAllFundamentalsRows();
    if (rows.length === 0) return res.json([]);

    type Metric = { key: string; weight: number; higherBetter: boolean; getValue: (r: typeof rows[0]) => number | null };

    function n(v: string | null | undefined): number | null {
      if (v == null) return null;
      const x = parseFloat(v);
      return isFinite(x) ? x : null;
    }

    const METRICS: Metric[] = [
      // Quality (35% of PUT_SELLER preset)
      { key: "grossMargin",      weight: 2.0, higherBetter: true,  getValue: r => n(r.grossMargin) },
      { key: "operatingMargin",  weight: 2.0, higherBetter: true,  getValue: r => n(r.operatingMargin) },
      { key: "netMargin",        weight: 3.0, higherBetter: true,  getValue: r => n(r.netMargin) },
      { key: "roe",              weight: 2.0, higherBetter: true,  getValue: r => n(r.returnOnEquity) },
      { key: "roicWacc",         weight: 1.5, higherBetter: true,  getValue: r => {
        const roic = n(r.roic); const wacc = n(r.wacc);
        return roic !== null && wacc !== null ? roic - wacc : null;
      }},
      // Growth (25%)
      { key: "revGrowth",        weight: 3.0, higherBetter: true,  getValue: r => n(r.revenueGrowthYoY) },
      { key: "epsGrowth",        weight: 3.0, higherBetter: true,  getValue: r => n(r.epsGrowth) },
      // Safety (20%)
      { key: "currentRatio",     weight: 1.5, higherBetter: true,  getValue: r => n(r.currentRatio) },
      { key: "debtToEquity",     weight: 1.0, higherBetter: false, getValue: r => n(r.debtToEquity) },
      { key: "intCoverage",      weight: 2.5, higherBetter: true,  getValue: r => {
        const ebit = n(r.ebit); const ie = n(r.interestExpense);
        return ebit !== null && ie !== null && ie > 0 ? ebit / ie : null;
      }},
      { key: "cashRunway",       weight: 3.0, higherBetter: true,  getValue: r => {
        const cash = n(r.cashAndEquivalents); const ocf = n(r.quarterlyOperatingCashFlow);
        return cash !== null && ocf !== null && ocf > 0 ? cash / (ocf * 4) : null;
      }},
    ];

    // Build peerGroupMap from DB — no external API calls
    const tickers = rows.map(r => r.ticker);
    const [regRows, ] = await Promise.all([
      db.select({ ticker: tickerRegistry.ticker, primaryPeerGroupId: tickerRegistry.primaryPeerGroupId })
        .from(tickerRegistry)
        .where(inArray(tickerRegistry.ticker, tickers)),
    ]);
    const peerGroupByTicker = new Map(regRows.map(r => [r.ticker, r.primaryPeerGroupId ?? null]));
    const uniqueGroupIds = [...new Set(regRows.map(r => r.primaryPeerGroupId).filter((g): g is string => !!g))];
    const groupExclusionRows = uniqueGroupIds.length > 0
      ? await db.select({ id: peerGroups.id, metricExclusions: peerGroups.metricExclusions })
          .from(peerGroups)
          .where(inArray(peerGroups.id, uniqueGroupIds))
      : [];
    const exclusionsByGroup = new Map(groupExclusionRows.map(g => [g.id, new Set(g.metricExclusions ?? [])]));

    // Cross-sectional percentile rank per metric
    const values = METRICS.map(m => rows.map(r => m.getValue(r)));

    // Apply group metric exclusions and roe structural null (direction-inversion only)
    rows.forEach((row, ri) => {
      const groupId = peerGroupByTicker.get(row.ticker);
      const excl = groupId ? (exclusionsByGroup.get(groupId) ?? new Set<string>()) : new Set<string>();
      METRICS.forEach((m, mi) => {
        if (excl.has(m.key)) { values[mi][ri] = null; return; }
        // roe: directionally broken when equity is negative but company is profitable
        if (m.key === "roe" && row.totalStockholdersEquity !== null && row.netIncome !== null) {
          const eq_ = parseFloat(row.totalStockholdersEquity ?? "");
          const ni  = parseFloat(row.netIncome ?? "");
          if (isFinite(eq_) && isFinite(ni) && eq_ < 0 && ni > 0) values[mi][ri] = null;
        }
      });
    });

    const pctRanks: (number | null)[][] = METRICS.map((m, mi) => {
      const vals = values[mi];
      const nonNull = vals.filter(v => v !== null) as number[];
      if (nonNull.length === 0) return vals.map(() => null);
      const sorted = [...nonNull].sort((a, b) => a - b);
      return vals.map(v => {
        if (v === null) return null;
        const idx = sorted.findIndex(s => s >= v);
        const pct = sorted.length === 1 ? 0.5 : idx / (sorted.length - 1);
        return m.higherBetter ? pct : 1 - pct;
      });
    });

    const result = rows.map((row, ri) => {
      let weightedSum = 0;
      let totalWeight = 0;
      METRICS.forEach((m, mi) => {
        const pct = pctRanks[mi][ri];
        if (pct !== null) { weightedSum += pct * m.weight; totalWeight += m.weight; }
      });
      const totalScore = totalWeight > 0 ? (weightedSum / totalWeight) * 100 : 50;
      return { ticker: row.ticker, totalScore: parseFloat(totalScore.toFixed(2)) };
    });

    return res.json(result);
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
