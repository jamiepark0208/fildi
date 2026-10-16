import { Router } from "express";
import { requireAdmin } from "../middleware/requireAdmin.js";
import { requireAuth } from "../middleware/requireAuth.js";
import { computeTechnicalRankingsV2 } from "@workspace/option-scoring";
import { getUnionWatchlistTickers } from "../lib/watchlist-tickers.js";
import {
  getStaleTechnicalTickers,
  getAllTechnicalsStatus,
  getAllTechnicalsRows,
  refreshTechnicals,
  readTechnicalsRow,
  refreshTechnicalsForTicker,
} from "../lib/technicals-db.js";
import { TTLCache } from "../lib/ttl-cache.js";
import { logger } from "../lib/logger.js";

const router = Router();

export { refreshTechnicals };

/** Side-aware V2 totals — Options/Live need put vs call, not one-sided tech_score_snapshots. */
export const techRankingsCache = new TTLCache<
  Array<{ ticker: string; totalScore: number }>
>(15 * 60 * 1000, "technicals-rankings", 4);

/** Fields Options/Live need for StockContext / relativeMove / scorecard — not full V2 scoring. */
const SLIM_TECH_KEYS = [
  "ticker",
  "technicalsCoverage",
  "rsi14",
  "atr14",
  "stoch",
  "ma200",
  "ivRank",
  "ivPercentile",
  "ivVsRealizedVol",
  "basicSkew",
  "atmPutIv",
  "swingLow20d",
  "swingLow50d",
  "pivotS1",
  "swingHigh20d",
  "swingHigh50d",
  "pivotR1",
  "nearestSupportDistPct",
  "earningsDaysOut",
  "priceZScore",
  "priceVsMa50Atr",
  "fallingKnife",
] as const;

// POST /technicals/refresh — 202 fire-and-forget; refreshes stale tickers.
// Pass ?force=true to refresh all tickers regardless of last-fetched time.
router.post("/technicals/refresh", requireAdmin, async (req, res) => {
  try {
    const force = req.query["force"] === "true";
    const unionTickers = await getUnionWatchlistTickers();
    const tickers = force ? unionTickers : await getStaleTechnicalTickers(unionTickers);
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
    const unionTickers = await getUnionWatchlistTickers();
    const summary = unionTickers.map(t => ({
      ticker:      t,
      lastFetched: byTicker[t]?.lastFetched ?? null,
      coveragePct: byTicker[t]?.coveragePct ?? null,
    }));
    return res.json({ tickers: summary });
  } catch (err: any) {
    return res.status(500).json({ error: String(err?.message ?? err) });
  }
});

// GET /technicals/rankings?side=put|call — slim side-aware V2 totals (TTL 15m).
// Prefer this over shipping /technicals/all + client computeTechnicalRankingsV2.
router.get("/technicals/rankings", async (req, res) => {
  try {
    const sideRaw = String(req.query["side"] ?? "put").toLowerCase();
    const side: "put" | "call" = sideRaw === "call" ? "call" : "put";
    const cacheKey = side;
    const hit = techRankingsCache.get(cacheKey);
    if (hit) return res.json(hit);

    const rows = await getAllTechnicalsRows();
    const scored = computeTechnicalRankingsV2(rows as any, {}, undefined, side).map((s) => ({
      ticker: s.ticker,
      totalScore: s.totalScore,
    }));
    techRankingsCache.set(cacheKey, scored);
    return res.json(scored);
  } catch (err: any) {
    return res.status(500).json({ error: String(err?.message ?? err) });
  }
});

// GET /technicals/all — all DB rows for the V2 technical scorer.
// ?slim=1 → Options/Live StockContext fields only (~compact vs full enriched rows).
router.get("/technicals/all", async (req, res) => {
  try {
    const rows = await getAllTechnicalsRows();
    if (String(req.query["slim"] ?? "") === "1") {
      return res.json(
        rows.map((r) => {
          const out: Record<string, unknown> = {};
          for (const k of SLIM_TECH_KEYS) out[k] = (r as any)[k] ?? null;
          return out;
        }),
      );
    }
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
