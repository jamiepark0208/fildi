import { Router } from "express";
import { eq, and, asc, inArray } from "drizzle-orm";
import { db, watchlist, tickerRegistry, peerGroupMembers } from "@workspace/db";
import { requireAuth } from "../middleware/requireAuth.js";

const router = Router();

// Bounds client-side N+1 quote fan-out (see bug/12); must stay > register seed size if seeding is reintroduced.
const MAX_WATCHLIST_SIZE = 75;

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

  const existingCount = await db.$count(watchlist, eq(watchlist.userId, req.session.userId!));
  if (existingCount >= MAX_WATCHLIST_SIZE) {
    return res.status(400).json({ error: `Watchlist is full (max ${MAX_WATCHLIST_SIZE} tickers)` });
  }

  await db.insert(watchlist)
    .values({ userId: req.session.userId!, ticker: normalized, tier: 1, status: "monitoring" })
    .onConflictDoNothing();

  // Ensure ticker is in ticker_registry with fetch_fundamentals=true.
  // Uses upsert so a brand-new ticker gets a registry row automatically.
  await db.insert(tickerRegistry)
    .values({ ticker: normalized, isActive: true, fetchFundamentals: true })
    .onConflictDoUpdate({
      target: tickerRegistry.ticker,
      set: { fetchFundamentals: true },
    });

  // Flag all tickers in the same peer group(s) so backfills cover peers automatically.
  const groups = await db
    .select({ groupId: peerGroupMembers.groupId })
    .from(peerGroupMembers)
    .where(eq(peerGroupMembers.ticker, normalized));

  const warnings: string[] = [];

  if (groups.length === 0) {
    // No peer group: backfills will fetch this ticker alone. Needs manual peer group assignment.
    warnings.push(`${normalized} has no peer group — add it to a peer group and re-run to flag peers`);
    console.warn(`[watchlist] ${normalized} added with no peer group membership`);
  } else {
    const groupIds = groups.map(r => r.groupId);
    const peers = await db
      .select({ ticker: peerGroupMembers.ticker })
      .from(peerGroupMembers)
      .where(inArray(peerGroupMembers.groupId, groupIds));

    const peerTickers = [...new Set(peers.map(r => r.ticker))].filter(t => t !== normalized);

    if (peerTickers.length > 0) {
      await db
        .update(tickerRegistry)
        .set({ fetchFundamentals: true })
        .where(inArray(tickerRegistry.ticker, peerTickers));
    }
  }

  return res.status(201).json({
    ticker: normalized,
    ...(warnings.length > 0 ? { warnings } : {}),
  });
});

// DELETE /watchlist/:ticker
router.delete("/watchlist/:ticker", async (req, res) => {
  await db.delete(watchlist)
    .where(and(eq(watchlist.userId, req.session.userId!), eq(watchlist.ticker, req.params["ticker"]!)));
  return res.json({ ok: true });
});

export default router;
