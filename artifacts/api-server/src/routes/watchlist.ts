import { Router } from "express";
import { eq, and, asc, sql } from "drizzle-orm";
import { db, watchlist, tickerRegistry, peerGroupMembers, users } from "@workspace/db";
import { requireAuth } from "../middleware/requireAuth.js";
import { classifyTicker } from "../lib/peer-classifier.js";
import { isExcludedEtf } from "../lib/etf-exclusions.js";
import { enrichAndMergeTickers } from "../lib/enrich-and-merge.js";

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

  // Registry upsert is best-effort: watchlist membership must not fail if registry
  // write hits a transient error (migration drift, lock). Enrichment peers the flag later.
  // ETFs may sit on a watchlist for price tracking but never enter stock peer scoring.
  const etf = isExcludedEtf(normalized);
  try {
    await db.insert(tickerRegistry)
      .values({ ticker: normalized, isActive: true, fetchFundamentals: !etf })
      .onConflictDoUpdate({
        target: tickerRegistry.ticker,
        set: { fetchFundamentals: !etf },
      });
  } catch (err) {
    console.warn(`[watchlist] ticker_registry upsert failed for ${normalized}:`, err);
  }

  // bug/9: peers used to get fetchFundamentals=true synchronously here, which meant
  // one watchlist add could flag an entire peer group (up to hundreds of tickers)
  // for fundamentals fetch on every request. Peers still need fetchFundamentals=true
  // for peer-relative scoring to work — that flip now happens in nightly-enrichment.ts,
  // budget-gated, instead of unbounded on the request path.
  let groups: { groupId: string }[] = [];
  try {
    groups = await db
      .select({ groupId: peerGroupMembers.groupId })
      .from(peerGroupMembers)
      .where(eq(peerGroupMembers.ticker, normalized));
  } catch (err) {
    console.warn(`[watchlist] peer lookup failed for ${normalized}:`, err);
  }

  const warnings: string[] = [];
  let peerGroup: { id: string; confidence: string } | null = null;

  if (etf) {
    warnings.push(`${normalized} is an ETF — excluded from stock peer relative scoring`);
  } else if (groups.length === 0) {
    try {
      const cls = await classifyTicker(normalized);
      if (cls.groupId && cls.groupId !== "__global__" && cls.confidence !== "unmapped") {
        peerGroup = { id: cls.groupId, confidence: cls.confidence };
        groups = [{ groupId: cls.groupId }];
        console.log(`[watchlist] ${normalized} auto-classified → ${cls.groupId} (${cls.confidence})`);
      } else {
        warnings.push(`${normalized} could not be auto-mapped to a peer group — review Unmapped in Settings`);
        console.warn(`[watchlist] ${normalized} added but still unmapped`);
      }
    } catch (err) {
      warnings.push(`${normalized} peer auto-classify failed — will retry on nightly`);
      console.warn(`[watchlist] classify failed for ${normalized}:`, err);
    }
  } else {
    peerGroup = { id: groups[0]!.groupId, confidence: "mapped" };
  }

  // Kick off fundamentals for new names immediately (don't wait for 4d full nightly).
  if (!etf) {
    void enrichAndMergeTickers([normalized], { respectMutex: true })
      .then((r) => {
        if (r.skipped) console.warn(`[watchlist] enrich skipped for ${normalized}: ${r.reason}`);
        else console.log(`[watchlist] enrich ${normalized}: fetched=${r.fetched} failed=${r.failed}`);
      })
      .catch((err) => console.warn(`[watchlist] enrich failed for ${normalized}:`, err));
  }

  return res.status(201).json({
    ticker: normalized,
    ...(peerGroup ? { peerGroup } : {}),
    ...(warnings.length > 0 ? { warnings } : {}),
  });
});

// PATCH /watchlist/:ticker — update color tag
router.patch("/watchlist/:ticker", async (req, res) => {
  const { colorTag } = req.body as { colorTag?: string };
  if (typeof colorTag !== "string" || !COLOR_TAG_RE.test(colorTag)) {
    return res.status(400).json({ error: "colorTag must be a 6-digit hex color or empty" });
  }
  const ticker = String(req.params["ticker"] ?? "").trim().toUpperCase();
  if (!ticker) return res.status(400).json({ error: "ticker required" });

  const result = await db.update(watchlist)
    .set({ colorTag })
    .where(and(eq(watchlist.userId, req.session.userId!), eq(watchlist.ticker, ticker)))
    .returning({ ticker: watchlist.ticker });
  if (result.length === 0) return res.status(404).json({ error: "Ticker not in watchlist" });
  return res.json({ ok: true });
});

// DELETE /watchlist/:ticker
router.delete("/watchlist/:ticker", async (req, res) => {
  const ticker = String(req.params["ticker"] ?? "").trim().toUpperCase();
  if (!ticker) return res.status(400).json({ error: "ticker required" });
  await db.delete(watchlist)
    .where(and(eq(watchlist.userId, req.session.userId!), eq(watchlist.ticker, ticker)));
  return res.json({ ok: true });
});

export default router;
