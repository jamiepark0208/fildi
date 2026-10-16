import { Router } from "express";
import { requireAuth } from "../middleware/requireAuth.js";
import { getApiUsageHistory } from "../lib/api-usage.js";
import { getAiSpendThisMonth } from "../lib/ai-usage.js";

const router = Router();

// GET /api-usage/history?days=5
// Returns daily call counts per source for the past N days.
// Used by the API Monitor tab in Settings.
router.get("/api-usage/history", requireAuth, async (req, res, next) => {
  try {
    const days = Math.min(Math.max(parseInt(String(req.query.days ?? "5"), 10) || 5, 1), 30);
    const rows = await getApiUsageHistory(days);
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

// GET /api-usage/ai-spend — month-to-date metered LLM calls + est $ by surface (A130).
router.get("/api-usage/ai-spend", requireAuth, async (_req, res, next) => {
  try {
    res.json(await getAiSpendThisMonth());
  } catch (err) {
    next(err);
  }
});

export default router;
