import { Router } from "express";
import { eq, and, asc } from "drizzle-orm";
import { db, watchlist } from "@workspace/db";
import { requireAuth } from "../middleware/requireAuth.js";

const router = Router();

// All watchlist routes require auth
router.use(requireAuth);

// GET /watchlist
router.get("/watchlist", async (req, res) => {
  const rows = await db.select({ ticker: watchlist.ticker, addedAt: watchlist.addedAt })
    .from(watchlist)
    .where(eq(watchlist.userId, req.session.userId!))
    .orderBy(asc(watchlist.addedAt));
  return res.json(rows);
});

// POST /watchlist
router.post("/watchlist", async (req, res) => {
  const { ticker } = req.body as { ticker?: string };
  if (!ticker || typeof ticker !== "string") {
    return res.status(400).json({ error: "ticker is required" });
  }
  const normalized = ticker.trim().toUpperCase();
  if (normalized.length === 0 || normalized.length > 10) {
    return res.status(400).json({ error: "ticker must be 1-10 characters" });
  }

  await db.insert(watchlist)
    .values({ userId: req.session.userId!, ticker: normalized, tier: 1, status: "monitoring" })
    .onConflictDoNothing();

  return res.status(201).json({ ticker: normalized });
});

// DELETE /watchlist/:ticker
router.delete("/watchlist/:ticker", async (req, res) => {
  await db.delete(watchlist)
    .where(and(eq(watchlist.userId, req.session.userId!), eq(watchlist.ticker, req.params["ticker"]!)));
  return res.json({ ok: true });
});

export default router;
