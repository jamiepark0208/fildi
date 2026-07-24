import { Router } from "express";
import { requireAdmin } from "../middleware/requireAdmin.js";
import {
  lastEnrichmentRun, enrichmentRunning,
  lastRetentionPrune,
  lastTradeExpiryRun, tradeExpiryRunning,
  lastRegimeCheckpointRun, regimeCheckRunning,
} from "../lib/scheduler.js";

const router = Router();

router.get("/admin/scheduled-tasks", requireAdmin, (_req, res) => {
  res.json({
    generatedAt: Date.now(),
    tasks: [
      {
        name: "Nightly Enrichment",
        description: "Refreshes fundamentals from Polygon/AlphaVantage and merges into the trusted table.",
        schedule: "Sunday & Thursday, 02:00 UTC",
        lastRun: lastEnrichmentRun?.toISOString() ?? null,
        running: enrichmentRunning,
      },
      {
        name: "Retention Prune",
        description: "Trims old rows from high-volume tables (price history, logs) to keep the DB size bounded.",
        schedule: "Daily (any hour, once per UTC day)",
        lastRun: lastRetentionPrune?.toISOString() ?? null,
        running: false,
      },
      {
        name: "Trade Idea Expiry Resolution",
        description: "Settles option trade ideas (sell/buy call/put) left OPEN past their Friday expiry against the underlying's close price.",
        schedule: "Saturday, 02:00 UTC",
        lastRun: lastTradeExpiryRun?.toISOString() ?? null,
        running: tradeExpiryRunning,
      },
      {
        name: "Intraday Regime Checkpoints",
        description: "Samples SPY/QQQ at 15/30/45/60/90/120/150/180 min after the open to classify the day as trend vs. reversal, feeding the Live tab's regime banner.",
        schedule: "Weekdays, 15/30/45/60/90/120/150/180 min after 9:30 ET (skips NYSE holidays)",
        lastRun: lastRegimeCheckpointRun?.toISOString() ?? null,
        running: regimeCheckRunning,
      },
    ],
  });
});

export default router;
