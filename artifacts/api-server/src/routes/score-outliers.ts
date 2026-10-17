/**
 * A102 — GET /api/research/score-outliers · POST disposition
 */
import { Router } from "express";
import { requireAdmin } from "../middleware/requireAdmin.js";
import {
  buildScoreOutliers,
  setOutlierDisposition,
  type Disposition,
  type OutlierKind,
} from "../lib/score-outliers.js";

const router = Router();
const KINDS = new Set<OutlierKind>([
  "fund_high", "fund_low", "tech_high", "tech_low", "fv_ratio", "pt_upside", "thin_data",
]);
const DISPS = new Set<Disposition>(["bug", "explained", "false_positive"]);

router.get("/research/score-outliers", requireAdmin, async (_req, res) => {
  try {
    const data = await buildScoreOutliers();
    return res.json(data);
  } catch (err) {
    return res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

router.post("/research/score-outliers/disposition", requireAdmin, async (req, res) => {
  try {
    const ticker = String(req.body?.ticker ?? "").toUpperCase();
    const kind = String(req.body?.kind ?? "") as OutlierKind;
    const disposition = String(req.body?.disposition ?? "") as Disposition;
    const note = req.body?.note != null ? String(req.body.note).slice(0, 500) : null;
    if (!/^[A-Z][A-Z0-9.-]{0,9}$/.test(ticker)) return res.status(400).json({ error: "bad ticker" });
    if (!KINDS.has(kind)) return res.status(400).json({ error: "bad kind" });
    if (!DISPS.has(disposition)) return res.status(400).json({ error: "bad disposition" });
    const setBy = String(req.session?.["userId"] ?? "admin");
    await setOutlierDisposition(ticker, kind, disposition, note, setBy);
    return res.json({ ok: true });
  } catch (err) {
    return res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

export default router;
