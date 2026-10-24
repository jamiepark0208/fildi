import { Router } from "express";
import { requireAdmin } from "../middleware/requireAdmin.js";
import { getApiUsageHistory } from "../lib/api-usage.js";
import { getAiSpendThisMonth } from "../lib/ai-usage.js";

const router = Router();

// GET /api-usage/history?days=5 — admin only (A235: global vendor + AI spend).
router.get("/api-usage/history", requireAdmin, async (req, res, next) => {
  try {
    const days = Math.min(Math.max(parseInt(String(req.query.days ?? "5"), 10) || 5, 1), 30);
    const rows = await getApiUsageHistory(days);
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

// GET /api-usage/ai-spend — month-to-date metered LLM calls + est $ by surface (A130).
router.get("/api-usage/ai-spend", requireAdmin, async (_req, res, next) => {
  try {
    res.json(await getAiSpendThisMonth());
  } catch (err) {
    next(err);
  }
});

export default router;
