import { Router } from "express";
import { requireAdmin } from "../middleware/requireAdmin.js";
import YahooFinanceClass from "yahoo-finance2";
import { WATCHLIST } from "../lib/constants.js";
import { fetchFMPFundamentals } from "../lib/fmp-client.js";
import { writeFundamentalsRow, checkTriangulation, getStaleTickers, getAllFundamentalsStatus, checkFMPBudget, recordFMPCalls, getAllFundamentalsRows } from "../lib/fundamentals-db.js";
import { getLatestRegime } from "./regime.js";
import { logger } from "../lib/logger.js";
import { StockDataManager, type HistoryCSVRow } from "../lib/stock-data-manager.js";
import { classifyTicker, type PeerGroupClassification } from "../lib/peer-classifier.js";
import { db, unmappedTickers, tickerRegistry, peerGroups, peerGroupMembers, tickerFundamentals } from "@workspace/db";
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

    const regime = await getLatestRegime();
    await writeFundamentalsRow(ticker, fmpData, discrepancyFlags, regime);
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
    const [rows, regime] = await Promise.all([
      getAllFundamentalsRows(),
      getLatestRegime(),
    ]);
    if (rows.length === 0) return res.json([]);

    type Family = 'quality' | 'growth' | 'safety';
    type Metric = { key: string; family: Family; weight: number; higherBetter: boolean; getValue: (r: typeof rows[0]) => number | null };

    function n(v: string | null | undefined): number | null {
      if (v == null) return null;
      const x = parseFloat(v);
      return isFinite(x) ? x : null;
    }

    // Family weights — resolved from regime, falling back to PUT_SELLER defaults
    const REGIME_WEIGHTS: Record<string, Record<Family, number>> = {
      expansion:   { quality: 30, growth: 35, safety: 20 },
      late_cycle:  { quality: 35, growth: 20, safety: 25 },
      contraction: { quality: 35, growth: 15, safety: 30 },
      recession:   { quality: 30, growth: 10, safety: 45 },
      recovery:    { quality: 30, growth: 35, safety: 20 },
      stagflation: { quality: 35, growth: 10, safety: 30 },
    };
    const familyWeights: Record<Family, number> = (regime && REGIME_WEIGHTS[regime])
      ? REGIME_WEIGHTS[regime]
      : { quality: 35, growth: 25, safety: 20 }; // PUT_SELLER defaults

    const METRICS: Metric[] = [
      // Quality
      { key: "grossMargin",     family: "quality", weight: 2.0, higherBetter: true,  getValue: r => n(r.grossMargin) },
      { key: "operatingMargin", family: "quality", weight: 2.0, higherBetter: true,  getValue: r => n(r.operatingMargin) },
      { key: "netMargin",       family: "quality", weight: 3.0, higherBetter: true,  getValue: r => n(r.netMargin) },
      { key: "roe",             family: "quality", weight: 2.0, higherBetter: true,  getValue: r => n(r.returnOnEquity) },
      { key: "roicWacc",        family: "quality", weight: 1.5, higherBetter: true,  getValue: r => {
        const roic = n(r.roic); const wacc = n(r.wacc);
        return roic !== null && wacc !== null ? roic - wacc : null;
      }},
      // Growth
      { key: "revGrowth",  family: "growth", weight: 3.0, higherBetter: true, getValue: r => n(r.revenueGrowthYoY) },
      { key: "epsGrowth",  family: "growth", weight: 3.0, higherBetter: true, getValue: r => n(r.epsGrowth) },
      // Safety
      { key: "currentRatio", family: "safety", weight: 1.5, higherBetter: true,  getValue: r => n(r.currentRatio) },
      { key: "debtToEquity", family: "safety", weight: 1.0, higherBetter: false, getValue: r => n(r.debtToEquity) },
      { key: "intCoverage",  family: "safety", weight: 2.5, higherBetter: true,  getValue: r => {
        const ebit = n(r.ebit); const ie = n(r.interestExpense);
        return ebit !== null && ie !== null && ie > 0 ? ebit / ie : null;
      }},
      { key: "cashRunway",   family: "safety", weight: 3.0, higherBetter: true,  getValue: r => {
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

    // Two-level scoring: family score = weighted avg of metric pct-ranks within family,
    // then totalScore = sum(familyScore * familyWeight) / sum(familyWeights).
    const FAMILIES: Family[] = ['quality', 'growth', 'safety'];
    const result = rows.map((row, ri) => {
      let totalNum = 0;
      let totalDen = 0;
      FAMILIES.forEach(fam => {
        const famMetrics = METRICS.map((m, mi) => ({ m, mi })).filter(({ m }) => m.family === fam);
        let famNum = 0; let famDen = 0;
        famMetrics.forEach(({ m, mi }) => {
          const pct = pctRanks[mi][ri];
          if (pct !== null) { famNum += pct * m.weight; famDen += m.weight; }
        });
        if (famDen > 0) {
          totalNum += (famNum / famDen) * familyWeights[fam];
          totalDen += familyWeights[fam];
        }
      });
      const totalScore = totalDen > 0 ? (totalNum / totalDen) * 100 : 50;
      return { ticker: row.ticker, totalScore: parseFloat(totalScore.toFixed(2)), regime: regime ?? "unknown" };
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
// GET /fundamentals/stock-db — admin only; full universe (watchlist + peers) with fundamentals rows.
// Returns every ticker in scope even if no DB row exists yet (so the grid shows coverage gaps).
router.get("/fundamentals/stock-db", requireAdmin, async (_req, res) => {
  try {
    const upper = WATCHLIST.map((t: string) => t.toUpperCase());

    const regRows = await db
      .select({ ticker: tickerRegistry.ticker, primaryPeerGroupId: tickerRegistry.primaryPeerGroupId })
      .from(tickerRegistry)
      .where(inArray(tickerRegistry.ticker, upper));

    const groupIds = [...new Set(regRows.map(r => r.primaryPeerGroupId).filter((g): g is string => !!g))];

    const memberRows = groupIds.length > 0
      ? await db.select({ ticker: peerGroupMembers.ticker, groupId: peerGroupMembers.groupId })
          .from(peerGroupMembers).where(inArray(peerGroupMembers.groupId, groupIds))
      : [];

    const watchlistSet = new Set(upper);
    const allTickers = [...new Set([...upper, ...memberRows.map(r => r.ticker.toUpperCase())])].sort();

    // Build peer-group lookup for context column
    const peerGroupByTicker = new Map<string, string>();
    regRows.forEach(r => { if (r.primaryPeerGroupId) peerGroupByTicker.set(r.ticker, r.primaryPeerGroupId); });
    memberRows.forEach(r => { if (!peerGroupByTicker.has(r.ticker.toUpperCase())) peerGroupByTicker.set(r.ticker.toUpperCase(), r.groupId); });

    // Fetch all existing fundamentals rows
    const fundRows = await db.select().from(tickerFundamentals)
      .where(inArray(tickerFundamentals.ticker, allTickers));
    const fundByTicker = new Map(fundRows.map(r => [r.ticker, r]));

    const result = allTickers.map(ticker => ({
      ticker,
      isWatchlist: watchlistSet.has(ticker),
      peerGroupId: peerGroupByTicker.get(ticker) ?? null,
      fundamentals: fundByTicker.get(ticker) ?? null,
    }));

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
