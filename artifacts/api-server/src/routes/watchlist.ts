import { Router } from "express";
import { eq, and, asc, sql } from "drizzle-orm";
import { db, watchlist, tickerRegistry, peerGroupMembers, users } from "@workspace/db";
import { requireAuth } from "../middleware/requireAuth.js";

const router = Router();

// Bounds client-side N+1 quote fan-out (see bug/12); must stay > register seed size if seeding is reintroduced.
const MAX_WATCHLIST_SIZE = 75;

// Matches PRESET_COLORS in use-watchlist.ts; '' clears the tag.
const COLOR_TAG_RE = /^(#[0-9a-fA-F]{6})?$/;

// All watchlist routes require auth
router.use(requireAuth);

// GET /watchlist
router.get("/watchlist", async (req, res) => {
  const rows = await db.select({ ticker: watchlist.ticker, addedAt: watchlist.addedAt, colorTag: watchlist.colorTag })
    .from(watchlist)
    .where(eq(watchlist.userId, req.session.userId!))
    .orderBy(asc(watchlist.addedAt));
  return res.json(rows);
});

// GET /watchlist/user/:username — another user's tagged watchlist, for profile viewing.
// Any signed-in user can view (mirrors existing /api/feed/buckets/:username visibility).
router.get("/watchlist/user/:username", async (req, res) => {
  const [target] = await db.select({ id: users.id })
    .from(users)
    .where(eq(sql`lower(${users.username})`, req.params["username"]!.toLowerCase()))
    .limit(1);
  if (!target) return res.status(404).json({ error: "User not found" });

  const rows = await db.select({ ticker: watchlist.ticker, addedAt: watchlist.addedAt, colorTag: watchlist.colorTag })
    .from(watchlist)
    .where(eq(watchlist.userId, target.id))
    .orderBy(asc(watchlist.addedAt));
  return res.json(rows);
});

// POST /watchlist
router.post("/watchlist", async (req, res) => {
  const { ticker, colorTag } = req.body as { ticker?: string; colorTag?: string };
  if (!ticker || typeof ticker !== "string") {
    return res.status(400).json({ error: "ticker is required" });
  }
  const normalized = ticker.trim().toUpperCase();
  if (normalized.length === 0 || normalized.length > 10) {
    return res.status(400).json({ error: "ticker must be 1-10 characters" });
  }
  if (colorTag !== undefined && !COLOR_TAG_RE.test(colorTag)) {
    return res.status(400).json({ error: "colorTag must be a 6-digit hex color or empty" });
  }

  const existingCount = await db.$count(watchlist, eq(watchlist.userId, req.session.userId!));
  if (existingCount >= MAX_WATCHLIST_SIZE) {
    return res.status(400).json({ error: `Watchlist is full (max ${MAX_WATCHLIST_SIZE} tickers)` });
  }

  await db.insert(watchlist)
    .values({ userId: req.session.userId!, ticker: normalized, tier: 1, status: "monitoring", colorTag: colorTag ?? "" })
    .onConflictDoNothing();

  // Ensure ticker is in ticker_registry with fetch_fundamentals=true.
  // Uses upsert so a brand-new ticker gets a registry row automatically.
  await db.insert(tickerRegistry)
    .values({ ticker: normalized, isActive: true, fetchFundamentals: true })
    .onConflictDoUpdate({
      target: tickerRegistry.ticker,
      set: { fetchFundamentals: true },
    });

  // bug/9: peers used to get fetchFundamentals=true synchronously here, which meant
  // one watchlist add could flag an entire peer group (up to hundreds of tickers)
  // for fundamentals fetch on every request. Peers still need fetchFundamentals=true
  // for peer-relative scoring to work — that flip now happens in nightly-enrichment.ts,
  // budget-gated, instead of unbounded on the request path.
  const groups = await db
    .select({ groupId: peerGroupMembers.groupId })
    .from(peerGroupMembers)
    .where(eq(peerGroupMembers.ticker, normalized));

  const warnings: string[] = [];

  if (groups.length === 0) {
    // No peer group: backfills will fetch this ticker alone. Needs manual peer group assignment.
    warnings.push(`${normalized} has no peer group — add it to a peer group and re-run to flag peers`);
    console.warn(`[watchlist] ${normalized} added with no peer group membership`);
  }

  return res.status(201).json({
    ticker: normalized,
    ...(warnings.length > 0 ? { warnings } : {}),
  });
});

// PATCH /watchlist/:ticker — update color tag
router.patch("/watchlist/:ticker", async (req, res) => {
  const { colorTag } = req.body as { colorTag?: string };
  if (typeof colorTag !== "string" || !COLOR_TAG_RE.test(colorTag)) {
    return res.status(400).json({ error: "colorTag must be a 6-digit hex color or empty" });
  }
  const result = await db.update(watchlist)
    .set({ colorTag })
    .where(and(eq(watchlist.userId, req.session.userId!), eq(watchlist.ticker, req.params["ticker"]!)))
    .returning({ ticker: watchlist.ticker });
  if (result.length === 0) return res.status(404).json({ error: "Ticker not in watchlist" });
  return res.json({ ok: true });
});

// DELETE /watchlist/:ticker
router.delete("/watchlist/:ticker", async (req, res) => {
  await db.delete(watchlist)
    .where(and(eq(watchlist.userId, req.session.userId!), eq(watchlist.ticker, req.params["ticker"]!)));
  return res.json({ ok: true });
});

export default router;
