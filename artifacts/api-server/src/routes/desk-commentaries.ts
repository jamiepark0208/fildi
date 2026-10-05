/**
 * Admin routes for desk commentary ingest + browse.
 * GET  /api/desk-commentaries?hours=36
 * GET  /api/desk-commentaries/session — current news-session rows (normalize fields)
 * GET  /api/desk-commentaries/parse-preview — dry normalize of Drive JSON (no DB write)
 * POST /api/desk-commentaries/ingest  (admin)
 * GET  /api/desk-commentaries/soft-context
 */
import { Router } from "express";
import { readdirSync, readFileSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { desc, gte, sql } from "drizzle-orm";
import { db, deskCommentaries } from "@workspace/db";
import { requireAdmin } from "../middleware/requireAdmin.js";
import {
  ingestDeskCommentaries,
  getDeskSoftContext,
  getDefaultBriefsDir,
  parseJsonSidecar,
} from "../lib/desk-commentary.js";
import { newsSessionWindow } from "../lib/desk-commentary-normalize.js";

const router = Router();

router.get("/desk-commentaries", async (req, res) => {
  try {
    const hours = Math.min(168, Math.max(1, Number(req.query["hours"] ?? 36) || 36));
    const since = new Date(Date.now() - hours * 60 * 60 * 1000);
    const rows = await db
      .select({
        id: deskCommentaries.id,
        source: deskCommentaries.source,
        kind: deskCommentaries.kind,
        category: deskCommentaries.category,
        noiseScore: deskCommentaries.noiseScore,
        fromDomain: deskCommentaries.fromDomain,
        subject: deskCommentaries.subject,
        receivedAt: deskCommentaries.receivedAt,
        ingestedAt: deskCommentaries.ingestedAt,
        tickersMentioned: deskCommentaries.tickersMentioned,
        synopsis: deskCommentaries.synopsis,
        driveFileName: deskCommentaries.driveFileName,
        articlePublishedAt: deskCommentaries.articlePublishedAt,
        meta: deskCommentaries.meta,
      })
      .from(deskCommentaries)
      .where(gte(deskCommentaries.receivedAt, since))
      .orderBy(desc(deskCommentaries.receivedAt))
      .limit(80);
    return res.json({ hours, count: rows.length, dir: getDefaultBriefsDir(), items: rows });
  } catch (err: any) {
    return res.status(500).json({ error: String(err?.message ?? err) });
  }
});

/** Current news session inbox — used by Live → News troubleshooting table. */
router.get("/desk-commentaries/session", async (_req, res) => {
  try {
    const win = newsSessionWindow();
    const rows = await db
      .select({
        id: deskCommentaries.id,
        source: deskCommentaries.source,
        kind: deskCommentaries.kind,
        category: deskCommentaries.category,
        noiseScore: deskCommentaries.noiseScore,
        fromDomain: deskCommentaries.fromDomain,
        subject: deskCommentaries.subject,
        receivedAt: deskCommentaries.receivedAt,
        synopsis: deskCommentaries.synopsis,
        tickersMentioned: deskCommentaries.tickersMentioned,
        articlePublishedAt: deskCommentaries.articlePublishedAt,
        meta: deskCommentaries.meta,
      })
      .from(deskCommentaries)
      .where(sql`${deskCommentaries.receivedAt} >= (${win.startDatePt}::date AT TIME ZONE 'America/Los_Angeles')`)
      .orderBy(desc(deskCommentaries.receivedAt))
      .limit(100);

    const items = rows.map((r) => {
      const meta = (r.meta ?? {}) as { includeInBrief?: boolean; noiseReasons?: string[]; contentLinks?: unknown[] };
      const includeInBrief =
        typeof meta.includeInBrief === "boolean"
          ? meta.includeInBrief
          : (r.noiseScore ?? 0) < 70 && r.category !== "promo";
      return {
        ...r,
        includeInBrief,
        noiseReasons: meta.noiseReasons ?? [],
        contentLinkCount: Array.isArray(meta.contentLinks) ? meta.contentLinks.length : 0,
      };
    });

    return res.json({
      sessionStartPt: win.startDatePt,
      sessionLabel: win.label,
      dateKey: win.dateKey,
      isWeekendPack: win.isWeekendPack,
      count: items.length,
      includedCount: items.filter((i) => i.includeInBrief).length,
      items,
    });
  } catch (err: any) {
    return res.status(500).json({ error: String(err?.message ?? err) });
  }
});

/** Dry-run normalize against Drive folder — no DB writes. */
router.get("/desk-commentaries/parse-preview", requireAdmin, async (req, res) => {
  try {
    const dir = typeof req.query["dir"] === "string" ? req.query["dir"] : getDefaultBriefsDir();
    const limit = Math.min(60, Math.max(1, Number(req.query["limit"] ?? 25) || 25));
    if (!existsSync(dir)) {
      return res.status(404).json({ error: `Drive folder missing: ${dir}` });
    }
    const files = readdirSync(dir)
      .filter((f) => f.endsWith(".json"))
      .map((f) => ({ f, mtime: statSync(join(dir, f)).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime)
      .slice(0, limit);

    const items = files.map(({ f }) => {
      const parsed = parseJsonSidecar(readFileSync(join(dir, f), "utf8"), f);
      if (!parsed) return { driveFileName: f, error: "parse_failed" };
      return {
        driveFileName: f,
        source: parsed.source,
        kind: parsed.kind,
        category: parsed.category,
        noiseScore: parsed.noiseScore,
        includeInBrief: (parsed.meta as { includeInBrief?: boolean }).includeInBrief,
        noiseReasons: (parsed.meta as { noiseReasons?: string[] }).noiseReasons ?? [],
        fromDomain: parsed.fromDomain,
        subject: parsed.subject,
        receivedAt: parsed.receivedAt,
        articlePublishedAt: parsed.articlePublishedAt,
        synopsis: parsed.synopsis?.slice(0, 180),
        tickersMentioned: parsed.tickersMentioned,
        contentLinks: ((parsed.meta as { contentLinks?: unknown[] }).contentLinks ?? []).slice(0, 3),
      };
    });

    return res.json({ dir, count: items.length, items });
  } catch (err: any) {
    return res.status(500).json({ error: String(err?.message ?? err) });
  }
});

router.get("/desk-commentaries/soft-context", async (req, res) => {
  try {
    const hours = Math.min(72, Math.max(1, Number(req.query["hours"] ?? 24) || 24));
    return res.json(await getDeskSoftContext(hours));
  } catch (err: any) {
    return res.status(500).json({ error: String(err?.message ?? err) });
  }
});

router.post("/desk-commentaries/ingest", requireAdmin, async (req, res) => {
  try {
    const sinceHours = typeof req.body?.sinceHours === "number" ? req.body.sinceHours : undefined;
    const limit = typeof req.body?.limit === "number" ? req.body.limit : undefined;
    const sinceMs =
      sinceHours != null ? Date.now() - sinceHours * 60 * 60 * 1000 : undefined;
    const result = await ingestDeskCommentaries({ sinceMs, limit });
    return res.json(result);
  } catch (err: any) {
    return res.status(500).json({ error: String(err?.message ?? err) });
  }
});

export default router;
