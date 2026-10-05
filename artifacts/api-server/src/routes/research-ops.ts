/**
 * GET /api/research/ops — WRDS/LSEG operational health (local cache + LSEG desktop port).
 * Never contacts WRDS Cloud or burns LSEG quota.
 */
import { Router } from "express";
import { requireAuth } from "../middleware/requireAuth.js";
import { getResearchOpsReport, lastResearchOpsReport } from "../lib/research-ops.js";

const router = Router();

router.get("/research/ops", requireAuth, async (_req, res) => {
  try {
    const report = await getResearchOpsReport();
    return res.json(report);
  } catch (err) {
    return res.status(500).json({
      error: err instanceof Error ? err.message : String(err),
      cached: lastResearchOpsReport,
    });
  }
});

export default router;
