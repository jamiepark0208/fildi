/**
 * A331 Backtest Lab API (P1 backend).
 */
import { Router } from "express";
import { requireAuth } from "../middleware/requireAuth.js";
import {
  buildStoreIfNeeded,
  enqueueBacktestRun,
  getBacktestCatalog,
  getBacktestRun,
  getBacktestRunTrades,
  inspectBacktest,
  listBacktestRuns,
  queueStatus,
  type BacktestRunParams,
} from "../lib/backtest-lab.js";

const router = Router();

router.get("/backtest/catalog", requireAuth, async (_req, res) => {
  try {
    return res.json(await getBacktestCatalog());
  } catch (err) {
    return res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

router.get("/backtest/inspect", requireAuth, async (req, res) => {
  const ticker = String(req.query.ticker ?? "");
  const date = String(req.query.date ?? "");
  const preset = req.query.preset ? String(req.query.preset) : undefined;
  if (!ticker || !date) return res.status(400).json({ error: "ticker and date required" });
  try {
    return res.json(await inspectBacktest(ticker, date, preset));
  } catch (err) {
    return res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

router.post("/backtest/run", requireAuth, async (req, res) => {
  const params = req.body as BacktestRunParams;
  if (!params?.preset && !params?.presetId) {
    return res.status(400).json({ error: "preset required" });
  }
  const createdBy = (req as unknown as { session?: { userId?: string } }).session?.userId;
  try {
    await buildStoreIfNeeded();
    const result = await enqueueBacktestRun(params, createdBy);
    return res.json({ runId: result.id, paramHash: result.paramHash, cached: result.cached, queue: queueStatus() });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("TIMEOUT") || msg.includes("ETIMEDOUT")) {
      return res.status(504).json({ error: "backtest deadline 120s exceeded", queue: queueStatus() });
    }
    return res.status(500).json({ error: msg });
  }
});

router.get("/backtest/runs", requireAuth, async (req, res) => {
  const limit = Math.min(100, Number(req.query.limit) || 30);
  try {
    return res.json({ runs: await listBacktestRuns(limit), queue: queueStatus() });
  } catch (err) {
    return res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

router.get("/backtest/runs/:id", requireAuth, async (req, res) => {
  const id = String(req.params.id);
  try {
    const row = await getBacktestRun(id, false);
    if (!row) return res.status(404).json({ error: "not found" });
    return res.json(row);
  } catch (err) {
    return res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

router.get("/backtest/runs/:id/trades", requireAuth, async (req, res) => {
  const id = String(req.params.id);
  try {
    const trades = await getBacktestRunTrades(id);
    return res.json({ trades });
  } catch (err) {
    return res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

export default router;
