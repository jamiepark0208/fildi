import { Router } from "express";
import { requireAdmin } from "../middleware/requireAdmin.js";
import { requireAuth } from "../middleware/requireAuth.js";
import { getUnionWatchlistTickers } from "../lib/watchlist-tickers.js";
import {
  getStaleTickers,
  getAllFundamentalsStatus,
  checkFMPBudget,
  getAllFundamentalsRows,
  computeAndPersistFundamentalScores,
  readPersistedScores,
} from "../lib/fundamentals-db.js";
import { CALLS_PER_TICKER } from "../lib/data-ops-config.js";
import { enrichAndMergeTickers } from "../lib/enrich-and-merge.js";
import { getLatestRegime } from "./regime.js";
import { logger } from "../lib/logger.js";
import { StockDataManager, type HistoryCSVRow } from "../lib/stock-data-manager.js";
import { db, unmappedTickers, tickerRegistry, peerGroups, peerGroupMembers, tickerFundamentals, tickerTechnicals, indicatorCache } from "@workspace/db";
import { desc, inArray, sql, eq } from "drizzle-orm";

const router = Router();

const FMP_CALLS = CALLS_PER_TICKER.fmp;

/**
 * Refresh fundamentals via the canonical enrich → populate → merge path.
 * Do not write gold from FMP alone (legacy single-source path removed).
 */
export async function refreshFundamentals(tickers: string[]): Promise<void> {
  logger.info({ count: tickers.length }, "fundamentals: starting enrich+merge refresh");

  const result = await enrichAndMergeTickers(tickers);
  if (!result.ok) {
    logger.warn({ reason: result.reason, tickers: tickers.length }, "fundamentals: enrich+merge incomplete");
  }

  logger.info({ count: tickers.length, fetched: result.fetched, failed: result.failed }, "fundamentals: refresh complete");

  try {
    const regime = await getLatestRegime();
    await computeAndPersistFundamentalScores(regime);
  } catch (err) {
    logger.warn({ err: String(err) }, "fundamentals: score recompute after refresh failed");
  }
}

// POST /fundamentals/refresh — enrich+merge for watchlist universe (budget gates FMP slice).
router.post("/fundamentals/refresh", requireAdmin, async (_req, res) => {
  const unionTickers = await getUnionWatchlistTickers();
  // Budget check uses FMP cost as the scarce ceiling; Yahoo/EDGAR still run inside enrich.
  const callsNeeded = Math.min(unionTickers.length, 25) * FMP_CALLS;
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
  res.status(202).json({
    message: "Fundamentals enrich+merge started",
    tickers: unionTickers.length,
    budgetRemaining: budget.remaining,
  });
  refreshFundamentals(unionTickers).catch((err) =>
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
router.get("/fundamentals/rankings", async (req, res) => {
  try {
    const regime = await getLatestRegime();

    // Serve persisted scores when fresh; recompute if stale or missing
    const cached = await readPersistedScores(regime);
    const results = cached ?? await computeAndPersistFundamentalScores(regime);
    // Options / Live only need ticker + totalScore (~23KB vs ~1.4MB with metricScores).
    if (String(req.query["slim"] ?? "") === "1") {
      return res.json(results.map((r: { ticker: string; totalScore: number | null }) => ({
        ticker: r.ticker,
        totalScore: r.totalScore,
      })));
    }
    return res.json(results);
  } catch (err: any) {
    return res.status(500).json({ error: String(err?.message ?? err) });
  }
});

// GET /fundamentals/unmapped — admin only; returns tickers that failed peer-group classification.
// GET /fundamentals/stock-db — active fundamentals universe only (fetch_fundamentals).
// Quarantined/delisted rows stay in ticker_fundamentals for history but must not
// dilute Stock DB coverage denominators.
router.get("/fundamentals/stock-db", requireAuth, async (_req, res) => {
  try {
    const watchlistSet = new Set((await getUnionWatchlistTickers()).map((t: string) => t.toUpperCase()));

    const [fundRows, regRows, groupRows, techRows, signalResult, priceResult, fwdResult] = await Promise.all([
      db
        .select({ fund: tickerFundamentals, fetchFundamentals: tickerRegistry.fetchFundamentals })
        .from(tickerFundamentals)
        .innerJoin(tickerRegistry, eq(tickerFundamentals.ticker, tickerRegistry.ticker))
        .where(eq(tickerRegistry.fetchFundamentals, true)),
      db.select({
        ticker: tickerRegistry.ticker,
        name: tickerRegistry.name,
        primaryPeerGroupId: tickerRegistry.primaryPeerGroupId,
        peerRep: tickerRegistry.peerRep,
      }).from(tickerRegistry),
      db.select({ id: peerGroups.id, name: peerGroups.name }).from(peerGroups),
      db.select().from(tickerTechnicals),
      db.execute<{ ticker: string; signal: string }>(sql`
        SELECT DISTINCT ON (ticker) ticker, signal
        FROM indicator_cache
        ORDER BY ticker, scored_date DESC
      `),
      db.execute<{ ticker: string; close: number }>(sql`
        SELECT DISTINCT ON (ticker) ticker, close::float8 AS close
        FROM prices_historical
        ORDER BY ticker, date DESC
      `),
      db.execute<{ ticker: string; forward_eps: number }>(sql`
        SELECT DISTINCT ON (ticker) ticker, value::float8 AS forward_eps
        FROM source_fundamentals
        WHERE field = 'forwardEps'
          AND source IN ('yahoo','finnhub','fmp','alpha_vantage')
          AND value::float8 <> 0
        ORDER BY ticker, fetched_at DESC
      `),
    ]);

    const regByTicker    = new Map(regRows.map(r => [r.ticker.toUpperCase(), r]));
    const groupNameById  = new Map(groupRows.map(g => [g.id, g.name]));
    const techByTicker   = new Map(techRows.map(r => [r.ticker.toUpperCase(), r]));
    const signalByTicker = new Map(signalResult.rows.map(r => [r.ticker.toUpperCase(), r.signal]));
    const priceByTicker  = new Map(priceResult.rows.map(r => [r.ticker.toUpperCase(), Number(r.close)]));
    const fwdEpsByTicker = new Map(fwdResult.rows.map(r => [r.ticker.toUpperCase(), Number(r.forward_eps)]));

    const result = fundRows.map(({ fund: row }) => {
      const reg     = regByTicker.get(row.ticker.toUpperCase());
      const groupId = reg?.primaryPeerGroupId ?? null;
      const px = priceByTicker.get(row.ticker.toUpperCase());
      const fwdEps = fwdEpsByTicker.get(row.ticker.toUpperCase());
      const shares = row.sharesOutstanding != null ? Number(row.sharesOutstanding) : NaN;
      const marketCap = px != null && Number.isFinite(px) && px > 0 && Number.isFinite(shares) && shares > 0
        ? px * shares
        : null;
      return {
        ticker:        row.ticker,
        companyName:   reg?.name ?? null,
        isWatchlist:   watchlistSet.has(row.ticker.toUpperCase()),
        isPeerRep:     reg?.peerRep === true,
        marketCap,
        peerGroupId:   groupId,
        peerGroupName: groupId ? (groupNameById.get(groupId) ?? null) : null,
        fundamentals:  { ...row, forwardEps: fwdEps != null && Number.isFinite(fwdEps) ? String(fwdEps) : null },
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

// PUT /fundamentals/peer-rep — mark a ticker as a peer anchor. Does not change scores.
router.put("/fundamentals/peer-rep", requireAdmin, async (req, res) => {
  const ticker = String(req.body?.ticker ?? "").toUpperCase();
  const peerRep = req.body?.peerRep === true;
  if (!/^[A-Z][A-Z0-9.-]{0,9}$/.test(ticker)) {
    return res.status(400).json({ error: "ticker required" });
  }
  try {
    const updated = await db.update(tickerRegistry)
      .set({ peerRep })
      .where(eq(tickerRegistry.ticker, ticker))
      .returning({ ticker: tickerRegistry.ticker, peerRep: tickerRegistry.peerRep });
    if (updated.length === 0) return res.status(404).json({ error: "ticker not in registry" });
    return res.json(updated[0]);
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
