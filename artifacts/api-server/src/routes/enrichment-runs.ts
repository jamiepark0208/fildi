import { Router } from "express";
import { db, enrichmentRuns } from "@workspace/db";
import { desc } from "drizzle-orm";
import { requireAdmin } from "../middleware/requireAdmin.js";

const router = Router();

const DEFAULT_LIMIT = 30;
const MAX_LIMIT = 100;

router.get("/admin/enrichment-runs", requireAdmin, async (req, res, next) => {
  try {
    const limit = Math.min(
      MAX_LIMIT,
      Math.max(1, Number(req.query.limit) || DEFAULT_LIMIT),
    );

    const rows = await db
      .select()
      .from(enrichmentRuns)
      .orderBy(desc(enrichmentRuns.startedAt))
      .limit(limit);

    res.json({ runs: rows });
  } catch (err) {
    next(err);
  }
});

export default router;
