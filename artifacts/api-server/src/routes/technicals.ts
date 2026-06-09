import { Router } from "express";
import { WATCHLIST } from "../lib/constants.js";
import {
  getStaleTechnicalTickers,
  getAllTechnicalsStatus,
  getAllTechnicalsRows,
  refreshTechnicals,
} from "../lib/technicals-db.js";
import { logger } from "../lib/logger.js";

const router = Router();

export { refreshTechnicals };

// POST /technicals/refresh — 202 fire-and-forget; refreshes stale tickers.
// Pass ?force=true to refresh all tickers regardless of last-fetched time.
router.post("/technicals/refresh", async (req, res) => {
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

export default router;
