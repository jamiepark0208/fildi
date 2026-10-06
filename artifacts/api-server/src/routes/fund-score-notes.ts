/**
 * Human fund-score notes + discretionary adj (never mutates model fund_* columns).
 */
import { Router } from "express";
import { and, desc, eq } from "drizzle-orm";
import { db, fundScoreNotes } from "@workspace/db";
import { requireAuth } from "../middleware/requireAuth.js";
import { requireAdmin } from "../middleware/requireAdmin.js";
import {
  activeAdjPoints,
  ensureFundScoreAccountabilityTables,
  readFundScoreHistory,
} from "../lib/fund-score-snapshots.js";
import { logger } from "../lib/logger.js";

const router = Router();

function etDateKey(d = new Date()): string {
  return d.toLocaleDateString("en-CA", { timeZone: "America/New_York" });
}

router.get("/stocks/:ticker/score-history", requireAuth, async (req, res) => {
  const ticker = String(req.params["ticker"] ?? "").toUpperCase();
  if (!ticker) {
    res.status(400).json({ error: "ticker required" });
    return;
  }
  try {
    const days = Math.min(Math.max(Number(req.query.days) || 365, 7), 2000);
    const history = await readFundScoreHistory(ticker, { days });
    const adj = await activeAdjPoints(ticker);
    res.json({ ticker, history, activeAdjPoints: adj });
  } catch (err) {
    logger.warn({ err: String(err), ticker }, "score-history failed");
    res.status(500).json({ error: "Failed to load score history" });
  }
});

router.get("/stocks/:ticker/score-notes", requireAuth, async (req, res) => {
  const ticker = String(req.params["ticker"] ?? "").toUpperCase();
  if (!ticker) {
    res.status(400).json({ error: "ticker required" });
    return;
  }
  try {
    const rows = await db
      .select()
      .from(fundScoreNotes)
      .where(eq(fundScoreNotes.ticker, ticker))
      .orderBy(desc(fundScoreNotes.createdAt))
      .limit(100);
    const adj = await activeAdjPoints(ticker);
    res.json({
      ticker,
      notes: rows.map((n) => ({
        id: n.id,
        asOf: String(n.asOf).slice(0, 10),
        body: n.body,
        author: n.author,
        tags: n.tags,
        adjPoints: n.adjPoints != null ? Number(n.adjPoints) : null,
        expiresAt: n.expiresAt?.toISOString() ?? null,
        createdAt: n.createdAt.toISOString(),
      })),
      activeAdjPoints: adj,
    });
  } catch (err) {
    logger.warn({ err: String(err), ticker }, "score-notes list failed");
    res.status(500).json({ error: "Failed to load notes" });
  }
});

router.post("/stocks/:ticker/score-notes", requireAuth, requireAdmin, async (req, res) => {
  const ticker = String(req.params["ticker"] ?? "").toUpperCase();
  if (!ticker) {
    res.status(400).json({ error: "ticker required" });
    return;
  }
  const body = String(req.body?.body ?? "").trim();
  if (!body || body.length > 2000) {
    res.status(400).json({ error: "body required (1–2000 chars)" });
    return;
  }
  const asOf = String(req.body?.asOf ?? etDateKey()).slice(0, 10);
  const tags = Array.isArray(req.body?.tags)
    ? req.body.tags.map((t: unknown) => String(t)).slice(0, 8)
    : [];
  const adjRaw = req.body?.adjPoints;
  const adjPoints =
    adjRaw === null || adjRaw === undefined || adjRaw === ""
      ? null
      : Number(adjRaw);
  if (adjPoints != null && (!Number.isFinite(adjPoints) || Math.abs(adjPoints) > 25)) {
    res.status(400).json({ error: "adjPoints must be between -25 and +25" });
    return;
  }
  let expiresAt: Date | null = null;
  if (req.body?.expiresAt) {
    const d = new Date(String(req.body.expiresAt));
    if (!Number.isFinite(d.getTime())) {
      res.status(400).json({ error: "invalid expiresAt" });
      return;
    }
    expiresAt = d;
  }
  const author = req.session["userId"] != null ? `user:${req.session["userId"]}` : "admin";

  try {
    await ensureFundScoreAccountabilityTables();
    const [row] = await db
      .insert(fundScoreNotes)
      .values({
        ticker,
        asOf: asOf as unknown as string,
        body,
        author,
        tags,
        adjPoints: adjPoints != null ? String(adjPoints) : null,
        expiresAt,
        linkedSnapshotAsOf: (req.body?.linkedSnapshotAsOf
          ? String(req.body.linkedSnapshotAsOf).slice(0, 10)
          : asOf) as unknown as string,
      })
      .returning();
    const adj = await activeAdjPoints(ticker);
    res.status(201).json({
      note: {
        id: row!.id,
        asOf: String(row!.asOf).slice(0, 10),
        body: row!.body,
        author: row!.author,
        tags: row!.tags,
        adjPoints: adjPoints,
        expiresAt: row!.expiresAt?.toISOString() ?? null,
        createdAt: row!.createdAt.toISOString(),
      },
      activeAdjPoints: adj,
    });
  } catch (err) {
    logger.warn({ err: String(err), ticker }, "score-notes create failed");
    res.status(500).json({ error: "Failed to create note" });
  }
});

router.delete("/stocks/:ticker/score-notes/:id", requireAuth, requireAdmin, async (req, res) => {
  const ticker = String(req.params["ticker"] ?? "").toUpperCase();
  const id = Number(req.params["id"]);
  if (!ticker || !Number.isFinite(id)) {
    res.status(400).json({ error: "ticker and id required" });
    return;
  }
  try {
    await db
      .delete(fundScoreNotes)
      .where(and(eq(fundScoreNotes.ticker, ticker), eq(fundScoreNotes.id, id)));
    const adj = await activeAdjPoints(ticker);
    res.json({ ok: true, activeAdjPoints: adj });
  } catch (err) {
    logger.warn({ err: String(err), ticker, id }, "score-notes delete failed");
    res.status(500).json({ error: "Failed to delete note" });
  }
});

export default router;
