/** A81 — GET /api/options/mover-facts?tickers=A,B */
import { Router } from "express";
import { requireAuth } from "../middleware/requireAuth.js";
import { buildMoverFacts, formatMoverFactLine } from "../lib/mover-facts.js";

const router = Router();

router.get("/options/mover-facts", requireAuth, async (req, res) => {
  try {
    const raw = String(req.query["tickers"] ?? "");
    const tickers = [...new Set(raw.split(",").map((t) => t.trim().toUpperCase()).filter(Boolean))];
    if (tickers.length === 0) return res.status(400).json({ error: "tickers required" });
    if (tickers.length > 80) return res.status(400).json({ error: "max 80 tickers" });
    const minAbs = Math.max(0, Math.min(20, parseFloat(String(req.query["minAbs"] ?? "5")) || 5));
    const facts = await buildMoverFacts(tickers);
    const rows = facts
      .filter((f) => f.movePct != null && Math.abs(f.movePct) >= minAbs)
      .map((f) => ({ ...f, line: formatMoverFactLine(f) }));
    return res.json({ minAbs, rows });
  } catch (err) {
    return res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

export default router;
