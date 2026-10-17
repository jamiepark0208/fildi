import { Router } from "express";
import { and, eq, isNull } from "drizzle-orm";
import { db, peerGroups, peerGroupMembers, peerGroupOverrides, tickerRegistry } from "@workspace/db";
import { requireAdmin } from "../middleware/requireAdmin.js";
import {
  classifyTicker, classifyTickerDefault, setPeerGroupOverride, clearPeerGroupOverride,
  cleanupOverrideDualMemberships,
} from "../lib/peer-classifier.js";
import { computeAndPersistFundamentalScores } from "../lib/fundamentals-db.js";
import { getLatestRegime } from "./regime.js";
import { logger } from "../lib/logger.js";

const router = Router();

function recomputeScoresAsync(reason: string) {
  getLatestRegime()
    .then((regime) => computeAndPersistFundamentalScores(regime, "peer_override"))
    .catch((err) =>
      logger.warn({ err: String(err) }, `peer-overrides: score recompute after ${reason} failed`),
    );
}

async function groupSummary(groupId: string | null) {
  if (!groupId || groupId === "__global__") return null;
  const rows = await db.select({ id: peerGroups.id, name: peerGroups.name })
    .from(peerGroups).where(eq(peerGroups.id, groupId)).limit(1);
  return rows[0] ?? null;
}

// A member is "scored here" (API field: isRepresentative, legacy name) when its own
// scoring cohort (ticker_registry.primary_peer_group_id) is this group. Scoring never
// reads peer_group_members or a hand-picked "representative" subset — cohort = all
// non-ETF tickers with the same primary, with 2nd/98th winsorization inside the group.
async function memberRoster(groupId: string | null) {
  if (!groupId || groupId === "__global__") return [];
  const rows = await db.select({
    ticker: peerGroupMembers.ticker,
    source: peerGroupMembers.source,
    primaryPeerGroupId: tickerRegistry.primaryPeerGroupId,
  })
    .from(peerGroupMembers)
    .leftJoin(tickerRegistry, eq(tickerRegistry.ticker, peerGroupMembers.ticker))
    .where(and(eq(peerGroupMembers.groupId, groupId), isNull(peerGroupMembers.removedAt)));
  return rows.map(r => ({
    ticker: r.ticker,
    source: r.source,
    isRepresentative: r.primaryPeerGroupId === groupId,
  }));
}

// ── GET /peers/groups — all peer groups for a reassignment dropdown ────────────
router.get("/peers/groups", requireAdmin, async (_req, res) => {
  try {
    const groups = await db.select({ id: peerGroups.id, name: peerGroups.name }).from(peerGroups).orderBy(peerGroups.id);
    return res.json({ groups });
  } catch (err: any) {
    return res.status(500).json({ error: String(err?.message ?? err) });
  }
});

// ── GET /peers/:ticker — current + default classification, roster, override state ─
router.get("/peers/:ticker", requireAdmin, async (req, res) => {
  const ticker = String(req.params.ticker).toUpperCase();
  try {
    const [current, groups, overrideRow] = await Promise.all([
      classifyTicker(ticker),
      db.select({ id: peerGroups.id, name: peerGroups.name }).from(peerGroups).orderBy(peerGroups.id),
      db.select({ note: peerGroupOverrides.note, createdAt: peerGroupOverrides.createdAt, previousGroupId: peerGroupOverrides.previousGroupId })
        .from(peerGroupOverrides).where(eq(peerGroupOverrides.ticker, ticker)).limit(1),
    ]);

    // "What reset-to-default will actually produce": the exact pre-override group
    // if one was recorded, otherwise a fresh auto-classification (matches what
    // clearPeerGroupOverride does — see peer-classifier.ts).
    const defaultGroupId = overrideRow[0]
      ? overrideRow[0].previousGroupId
      : (await classifyTickerDefault(ticker)).groupId;

    const [currentGroup, defaultGroup, members] = await Promise.all([
      groupSummary(current.groupId),
      groupSummary(defaultGroupId),
      memberRoster(current.groupId),
    ]);

    return res.json({
      ticker,
      confidence: current.confidence,
      currentGroup,
      defaultGroup,
      isOverridden: current.confidence === "override",
      override: overrideRow[0] ?? null,
      members: members.filter(m => m.ticker !== ticker),
      availableGroups: groups,
    });
  } catch (err: any) {
    logger.error({ ticker, err }, "GET /peers/:ticker failed");
    return res.status(500).json({ error: String(err?.message ?? err) });
  }
});

// ── PUT /peers/:ticker/group — reassign a ticker to a different peer group ─────
router.put("/peers/:ticker/group", requireAdmin, async (req, res) => {
  const ticker = String(req.params.ticker).toUpperCase();
  const { groupId, note } = req.body ?? {};
  if (!groupId) return res.status(400).json({ error: "groupId is required" });

  try {
    const exists = await db.select({ id: peerGroups.id }).from(peerGroups).where(eq(peerGroups.id, groupId)).limit(1);
    if (!exists[0]) return res.status(400).json({ error: `unknown peer group: ${groupId}` });

    await setPeerGroupOverride(ticker, groupId, note ?? null);
    recomputeScoresAsync("group reassignment");

    const classification = await classifyTicker(ticker);
    return res.json({ ok: true, classification });
  } catch (err: any) {
    logger.error({ ticker, err }, "PUT /peers/:ticker/group failed");
    return res.status(500).json({ error: String(err?.message ?? err) });
  }
});

// ── DELETE /peers/:ticker/group — revert to auto-classification ────────────────
router.delete("/peers/:ticker/group", requireAdmin, async (req, res) => {
  const ticker = String(req.params.ticker).toUpperCase();
  try {
    const classification = await clearPeerGroupOverride(ticker);
    recomputeScoresAsync("group override removal");
    return res.json({ ok: true, classification });
  } catch (err: any) {
    logger.error({ ticker, err }, "DELETE /peers/:ticker/group failed");
    return res.status(500).json({ error: String(err?.message ?? err) });
  }
});

// ── PUT /peers/group/:groupId/member — add a ticker to a group's peer roster ───
// Adding X to TICKER's group is mutual: X is inserted into the shared roster, and
// if X isn't already classified into this group, X also gets reassigned here (via
// a manual override) so X's own competitors list shows this group's members back.
router.put("/peers/group/:groupId/member", requireAdmin, async (req, res) => {
  const groupId = String(req.params.groupId);
  const { ticker, note } = req.body ?? {};
  if (!ticker) return res.status(400).json({ error: "ticker is required" });
  const newTicker = String(ticker).toUpperCase();

  try {
    const exists = await db.select({ id: peerGroups.id }).from(peerGroups).where(eq(peerGroups.id, groupId)).limit(1);
    if (!exists[0]) return res.status(400).json({ error: `unknown peer group: ${groupId}` });

    await db.insert(peerGroupMembers)
      .values({ groupId, ticker: newTicker, source: "manual", removedAt: null })
      .onConflictDoUpdate({ target: [peerGroupMembers.groupId, peerGroupMembers.ticker], set: { removedAt: null } });

    const newTickerClass = await classifyTicker(newTicker);
    if (newTickerClass.groupId !== groupId) {
      await setPeerGroupOverride(newTicker, groupId, note ?? "added as a peer via roster edit");
    }

    recomputeScoresAsync("roster member add");
    const members = await memberRoster(groupId);
    return res.json({ ok: true, members });
  } catch (err: any) {
    logger.error({ groupId, newTicker, err }, "PUT /peers/group/:groupId/member failed");
    return res.status(500).json({ error: String(err?.message ?? err) });
  }
});

// ── DELETE /peers/group/:groupId/member/:ticker — remove a ticker from a roster ─
// Taxonomy-sourced rows are soft-deleted (removedAt) so they can be restored;
// manually-added rows are hard-deleted. This only affects the roster display —
// the removed ticker's own classification/scoring cohort is left untouched.
router.delete("/peers/group/:groupId/member/:ticker", requireAdmin, async (req, res) => {
  const groupId = String(req.params.groupId);
  const memberTicker = String(req.params.ticker).toUpperCase();

  try {
    const rows = await db.select({ source: peerGroupMembers.source })
      .from(peerGroupMembers)
      .where(and(eq(peerGroupMembers.groupId, groupId), eq(peerGroupMembers.ticker, memberTicker)))
      .limit(1);
    if (!rows[0]) return res.status(404).json({ error: "not a member of this group" });

    if (rows[0].source === "manual") {
      await db.delete(peerGroupMembers).where(and(eq(peerGroupMembers.groupId, groupId), eq(peerGroupMembers.ticker, memberTicker)));
    } else {
      await db.update(peerGroupMembers).set({ removedAt: new Date() })
        .where(and(eq(peerGroupMembers.groupId, groupId), eq(peerGroupMembers.ticker, memberTicker)));
    }

    recomputeScoresAsync("roster member remove");
    const members = await memberRoster(groupId);
    return res.json({ ok: true, members });
  } catch (err: any) {
    logger.error({ groupId, memberTicker, err }, "DELETE /peers/group/:groupId/member/:ticker failed");
    return res.status(500).json({ error: String(err?.message ?? err) });
  }
});

// ── POST /peers/cleanup-override-duals — A147 one-shot (idempotent) ───────────
router.post("/peers/cleanup-override-duals", requireAdmin, async (_req, res) => {
  try {
    const result = await cleanupOverrideDualMemberships();
    if (result.fixed > 0) recomputeScoresAsync("A147 override dual cleanup");
    return res.json({ ok: true, ...result });
  } catch (err: any) {
    logger.error({ err }, "POST /peers/cleanup-override-duals failed");
    return res.status(500).json({ error: String(err?.message ?? err) });
  }
});

export default router;
