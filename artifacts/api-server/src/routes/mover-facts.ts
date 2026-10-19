/** A81 — GET /api/options/mover-facts?tickers=A,B[&movePct=A:36.3,B:-2.1] */
import { Router } from "express";
import { requireAuth } from "../middleware/requireAuth.js";
import { buildMoverFacts, formatMoverFactLine } from "../lib/mover-facts.js";

const router = Router();

function parseMovePct(raw: string): Record<string, number | null> | undefined {
  if (!raw.trim()) return undefined;
  const out: Record<string, number | null> = {};
  for (const part of raw.split(",")) {
    const i = part.indexOf(":");
    if (i <= 0) continue;
    const t = part.slice(0, i).trim().toUpperCase();
    const n = parseFloat(part.slice(i + 1));
    if (t) out[t] = Number.isFinite(n) ? n : null;
  }
  return Object.keys(out).length ? out : undefined;
}

router.get("/options/mover-facts", requireAuth, async (req, res) => {
  try {
    const raw = String(req.query["tickers"] ?? "");
    const tickers = [...new Set(raw.split(",").map((t) => t.trim().toUpperCase()).filter(Boolean))];
    if (tickers.length === 0) return res.status(400).json({ error: "tickers required" });
    if (tickers.length > 80) return res.status(400).json({ error: "max 80 tickers" });
    const minAbs = Math.max(0, Math.min(20, parseFloat(String(req.query["minAbs"] ?? "5")) || 5));
    const movePctByTicker = parseMovePct(String(req.query["movePct"] ?? ""));
    const facts = await buildMoverFacts(tickers, movePctByTicker);
    const rows = facts
      .filter((f) => f.movePct != null && Math.abs(f.movePct) >= minAbs)
      // omitMovePct: board already shows screener % — tooltip is driver/IV only
      .map((f) => ({ ...f, line: formatMoverFactLine(f, { omitMovePct: true }) }));
    return res.json({ minAbs, rows });
  } catch (err) {
    return res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

export default router;
