import { Router } from "express";
import { requireAdmin } from "../middleware/requireAdmin.js";
import { requireAuth } from "../middleware/requireAuth.js";
import { WATCHLIST } from "../lib/constants.js";
import {
  getStaleTechnicalTickers,
  getAllTechnicalsStatus,
  getAllTechnicalsRows,
  refreshTechnicals,
  readTechnicalsRow,
  refreshTechnicalsForTicker,
} from "../lib/technicals-db.js";
import { logger } from "../lib/logger.js";

const router = Router();

export { refreshTechnicals };

// POST /technicals/refresh — 202 fire-and-forget; refreshes stale tickers.
// Pass ?force=true to refresh all tickers regardless of last-fetched time.
router.post("/technicals/refresh", requireAdmin, async (req, res) => {
  try {
    const force = req.query["force"] === "true";
    const tickers = force ? WATCHLIST : await getStaleTechnicalTickers(WATCHLIST);
    if (tickers.length === 0) {
      return res.status(200).json({ message: "All technicals are fresh", tickers: 0 });
    }
    res.status(202).json({ message: "Technicals refresh started", tickers: tickers.length, force });
    refreshTechnicals(tickers).catch(err =>
      logger.error({ err }, "technicals: background refresh crashed")
    );
    return;
  } catch (err: any) {
    return res.status(500).json({ error: String(err?.message ?? err) });
  }
});

// GET /technicals/status — last-fetched timestamp and coverage per watchlist ticker.
router.get("/technicals/status", async (_req, res) => {
  try {
    const status = await getAllTechnicalsStatus();
    const byTicker = Object.fromEntries(status.map(s => [s.ticker, s]));
    const summary = WATCHLIST.map(t => ({
      ticker:      t,
      lastFetched: byTicker[t]?.lastFetched ?? null,
      coveragePct: byTicker[t]?.coveragePct ?? null,
    }));
    return res.json({ tickers: summary });
  } catch (err: any) {
    return res.status(500).json({ error: String(err?.message ?? err) });
  }
});

// GET /technicals/all — all DB rows for the V2 technical scorer.
router.get("/technicals/all", async (_req, res) => {
  try {
    const rows = await getAllTechnicalsRows();
    return res.json(rows);
  } catch (err: any) {
    return res.status(500).json({ error: String(err?.message ?? err) });
  }
});

// GET /technicals/:ticker — single row for chart overlays (auth required).
router.get("/technicals/:ticker", requireAuth, async (req, res) => {
  try {
    const ticker = String(req.params.ticker ?? "").toUpperCase();
    if (!ticker) return res.status(400).json({ error: "ticker required" });
    const row = await readTechnicalsRow(ticker);
    if (!row) return res.status(404).json({ error: "Technicals not found for ticker" });
    return res.json(row);
  } catch (err: any) {
    return res.status(500).json({ error: String(err?.message ?? err) });
  }
});

// POST /technicals/refresh/:ticker — sync recompute one ticker (admin only).
router.post("/technicals/refresh/:ticker", requireAdmin, async (req, res) => {
  try {
    const ticker = String(req.params.ticker ?? "").toUpperCase();
    if (!ticker) return res.status(400).json({ error: "ticker required" });
    const row = await refreshTechnicalsForTicker(ticker);
    if (!row) return res.status(404).json({ error: "Could not compute technicals (insufficient data)" });
    return res.json(row);
  } catch (err: any) {
    logger.error({ err, ticker: req.params.ticker }, "POST /technicals/refresh/:ticker failed");
    return res.status(500).json({ error: String(err?.message ?? err) });
  }
});

export default router;
