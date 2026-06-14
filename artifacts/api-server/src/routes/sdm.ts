import { Router } from "express";
import { eq } from "drizzle-orm";
import {
  db,
  dataSources,
  tickerRegistry,
  tickerFundamentals,
  tickerFundamentalsHistory,
} from "@workspace/db";
import { stockDataManager, type HistoryCSVRow } from "../lib/stock-data-manager.js";
import { logger } from "../lib/logger.js";

const router = Router();

// GET /sdm/status
// Returns all data sources with budgets, ticker registry count, and history row count.
router.get("/sdm/status", async (_req, res) => {
  try {
    const [sources, registryRows, historyRows] = await Promise.all([
      db.select().from(dataSources).orderBy(dataSources.priority),
      db.select({ ticker: tickerRegistry.ticker }).from(tickerRegistry),
      db.select({ ticker: tickerFundamentalsHistory.ticker }).from(tickerFundamentalsHistory),
    ]);

    const budgets = await stockDataManager.getSourceBudgets();

    return res.json({
      sources: sources.map(s => ({
        ...s,
        callsRemaining: budgets[s.name] ?? 0,
      })),
      tickerRegistryCount: registryRows.length,
      historyRowCount: historyRows.length,
    });
  } catch (err: any) {
    logger.error({ err }, "sdm: status error");
    return res.status(500).json({ error: String(err?.message ?? err) });
  }
});

// GET /sdm/tickers
// Returns ticker_registry joined with ticker_fundamentals including quality/source fields.
router.get("/sdm/tickers", async (_req, res) => {
  try {
    const registry = await db.select().from(tickerRegistry).orderBy(tickerRegistry.ticker);
    const fundamentals = await db
      .select({
        ticker:           tickerFundamentals.ticker,
        lastSource:       tickerFundamentals.lastSource,
        dataQualityScore: tickerFundamentals.dataQualityScore,
        lastFetched:      tickerFundamentals.fundamentalsLastFetched,
      })
      .from(tickerFundamentals);

    const fundMap = Object.fromEntries(fundamentals.map(f => [f.ticker, f]));

    return res.json(
      registry.map(r => ({
        ...r,
        lastSource:       fundMap[r.ticker]?.lastSource ?? null,
        dataQualityScore: fundMap[r.ticker]?.dataQualityScore ?? null,
        lastFetched:      fundMap[r.ticker]?.lastFetched ?? null,
      })),
    );
  } catch (err: any) {
    logger.error({ err }, "sdm: tickers error");
    return res.status(500).json({ error: String(err?.message ?? err) });
  }
});

// POST /sdm/refresh/:ticker  (admin only — ?admin=true)
// Forces a fresh fetch for a ticker, bypassing cache.
router.post("/sdm/refresh/:ticker", async (req, res) => {
  if (req.query["admin"] !== "true") {
    return res.status(403).json({ error: "Admin access required" });
  }

  const ticker = req.params["ticker"]?.toUpperCase();
  if (!ticker) return res.status(400).json({ error: "ticker required" });

  try {
    // Invalidate cache by clearing last-fetched timestamp so getFundamentals re-fetches
    await db
      .update(tickerFundamentals)
      .set({ fundamentalsLastFetched: null })
      .where(eq(tickerFundamentals.ticker, ticker));

    const result = await stockDataManager.getFundamentals(ticker);
    return res.json({
      ticker,
      source: result.source,
      fromCache: result.fromCache,
      dataQualityScore: result.data.dataQualityScore,
      lastFetched: result.data.fundamentalsLastFetched,
    });
  } catch (err: any) {
    logger.error({ ticker, err }, "sdm: refresh error");
    return res.status(500).json({ error: String(err?.message ?? err) });
  }
});

// POST /sdm/import-csv
// Accepts { rows: HistoryCSVRow[] } and imports each into ticker_fundamentals_history.
router.post("/sdm/import-csv", async (req, res) => {
  const { rows } = req.body as { rows?: unknown[] };
  if (!Array.isArray(rows)) {
    return res.status(400).json({ error: "body.rows must be an array" });
  }

  let imported = 0;
  const errors: string[] = [];

  for (const row of rows) {
    try {
      await stockDataManager.importHistoryRow(row as HistoryCSVRow);
      imported++;
    } catch (err: any) {
      errors.push(String(err?.message ?? err));
    }
  }

  return res.json({ imported, errors });
});

// GET /sdm/history/:ticker
// Returns all rows from ticker_fundamentals_history for a ticker, sorted by year ascending.
router.get("/sdm/history/:ticker", async (req, res) => {
  const ticker = req.params["ticker"]?.toUpperCase();
  if (!ticker) return res.status(400).json({ error: "ticker required" });

  try {
    const rows = await db
      .select()
      .from(tickerFundamentalsHistory)
      .where(eq(tickerFundamentalsHistory.ticker, ticker))
      .orderBy(tickerFundamentalsHistory.year);

    return res.json(rows);
  } catch (err: any) {
    logger.error({ ticker, err }, "sdm: history error");
    return res.status(500).json({ error: String(err?.message ?? err) });
  }
});

// GET /sdm/peers/:ticker
// Returns the ticker_registry row plus full peer data for each peer ticker.
router.get("/sdm/peers/:ticker", async (req, res) => {
  const ticker = req.params["ticker"]?.toUpperCase();
  if (!ticker) return res.status(400).json({ error: "ticker required" });

  try {
    const rows = await db
      .select()
      .from(tickerRegistry)
      .where(eq(tickerRegistry.ticker, ticker))
      .limit(1);

    if (rows.length === 0) {
      return res.status(404).json({ error: `ticker ${ticker} not found in registry` });
    }

    const entry = rows[0];
    const peerTickers = entry.peerTickers ?? [];

    // Fetch all peers individually (simple approach, peer lists are small)
    const peers = await Promise.all(
      peerTickers.map(p =>
        db.select().from(tickerRegistry).where(eq(tickerRegistry.ticker, p)).limit(1)
          .then(r => r[0] ?? null),
      ),
    );

    return res.json({
      ticker: entry,
      peers: peers.filter(Boolean),
    });
  } catch (err: any) {
    logger.error({ ticker, err }, "sdm: peers error");
    return res.status(500).json({ error: String(err?.message ?? err) });
  }
});

export default router;
