import { Router } from "express";
import { eq, and, asc, sql } from "drizzle-orm";
import { db, positions, userPortfolioNames } from "@workspace/db";
import { requireAuth } from "../middleware/requireAuth.js";

const router = Router();
router.use(requireAuth);

// GET /positions
router.get("/positions", async (req, res) => {
  const rows = await db.select()
    .from(positions)
    .where(eq(positions.userId, req.session.userId!))
    .orderBy(asc(positions.openedAt));
  return res.json(rows);
});

// POST /positions
router.post("/positions", async (req, res) => {
  const b = req.body as {
    accountId: string; ticker: string; positionType: string;
    qty: number; avgPrice: number | string;
    strike?: number | string; expiry?: string;
    openedAt?: string; notes?: string;
  };
  const [row] = await db.insert(positions).values({
    userId:       req.session.userId!,
    accountId:    b.accountId,
    ticker:       b.ticker.trim().toUpperCase(),
    positionType: b.positionType,
    qty:          Number(b.qty),
    avgPrice:     String(b.avgPrice),
    strike:       b.strike != null ? String(b.strike) : null,
    expiry:       b.expiry ?? null,
    openedAt:     b.openedAt ? new Date(b.openedAt) : new Date(),
    notes:        b.notes ?? null,
  }).returning({ id: positions.id });
  return res.status(201).json({ id: row.id });
});

// PATCH /positions/:id
router.patch("/positions/:id", async (req, res) => {
  const b = req.body as Partial<{
    accountId: string; ticker: string; positionType: string;
    qty: number; avgPrice: number | string;
    strike: number | string; expiry: string; notes: string;
  }>;
  const patch: Record<string, unknown> = {};
  if (b.accountId    !== undefined) patch.accountId    = b.accountId;
  if (b.ticker       !== undefined) patch.ticker       = b.ticker.trim().toUpperCase();
  if (b.positionType !== undefined) patch.positionType = b.positionType;
  if (b.qty          !== undefined) patch.qty          = Number(b.qty);
  if (b.avgPrice     !== undefined) patch.avgPrice     = String(b.avgPrice);
  if (b.strike       !== undefined) patch.strike       = b.strike != null ? String(b.strike) : null;
  if (b.expiry       !== undefined) patch.expiry       = b.expiry;
  if (b.notes        !== undefined) patch.notes        = b.notes;
  if (Object.keys(patch).length === 0) return res.status(400).json({ error: "nothing to update" });
  await db.update(positions)
    .set(patch)
    .where(and(eq(positions.id, Number(req.params.id)), eq(positions.userId, req.session.userId!)));
  return res.json({ ok: true });
});

// DELETE /positions/:id
router.delete("/positions/:id", async (req, res) => {
  await db.delete(positions)
    .where(and(eq(positions.id, Number(req.params.id)), eq(positions.userId, req.session.userId!)));
  return res.json({ ok: true });
});

// GET /portfolio-names
router.get("/portfolio-names", async (req, res) => {
  const rows = await db.select({ name: userPortfolioNames.name })
    .from(userPortfolioNames)
    .where(eq(userPortfolioNames.userId, req.session.userId!))
    .orderBy(asc(userPortfolioNames.sortOrder), asc(userPortfolioNames.name));
  return res.json(rows.map(r => r.name));
});

// POST /portfolio-names
router.post("/portfolio-names", async (req, res) => {
  const { name } = req.body as { name?: string };
  if (!name?.trim()) return res.status(400).json({ error: "name required" });
  const [{ c: sortOrder }] = await db.select({ c: sql<number>`count(*)`.mapWith(Number) })
    .from(userPortfolioNames)
    .where(eq(userPortfolioNames.userId, req.session.userId!));
  await db.insert(userPortfolioNames)
    .values({ userId: req.session.userId!, name: name.trim(), sortOrder })
    .onConflictDoNothing();
  return res.status(201).json({ ok: true });
});

// DELETE /portfolio-names/:name
router.delete("/portfolio-names/:name", async (req, res) => {
  await db.delete(userPortfolioNames)
    .where(and(eq(userPortfolioNames.userId, req.session.userId!), eq(userPortfolioNames.name, req.params.name)));
  return res.json({ ok: true });
});

export default router;
