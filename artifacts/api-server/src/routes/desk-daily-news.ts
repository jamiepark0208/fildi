/**
 * Daily News — Haiku summary of session desk commentaries (ad-hoc only).
 *
 * GET  /api/desk-commentaries/daily-news
 * POST /api/desk-commentaries/daily-news/refresh  (admin)
 * POST /api/desk-commentaries/daily-news/feedback (admin)
 * GET  /api/desk-commentaries/daily-news/feedback
 *
 * Session window: calendar day PT on weekdays; Fri→now on Sat/Sun / early Mon.
 */
import { Router } from "express";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { desc, sql, eq } from "drizzle-orm";
import { db, deskCommentaries, deskNewsFeedback } from "@workspace/db";
import { requireAdmin } from "../middleware/requireAdmin.js";
import { aiLimiter } from "../middleware/rateLimiter.js";
import { callHaiku } from "../lib/haiku.js";
import { ingestDeskCommentaries, ensureDeskCommentariesTable } from "../lib/desk-commentary.js";
import {
  DESK_BRIEF_PREFS,
  newsSessionWindow,
} from "../lib/desk-commentary-normalize.js";

const router = Router();

const __dir = dirname(fileURLToPath(import.meta.url));
const CACHE_PATH = join(__dir, "..", "..", "desk-daily-news.json");

interface DailyNewsCache {
  date: string; // PT dateKey when generated
  sessionStartPt: string;
  content: string;
  generatedAt: string;
  emailCount: number;
  includedCount: number;
  maxReceivedAt: string | null;
  sources: string[];
  categories: string[];
}

function loadCache(dateKey: string): DailyNewsCache | null {
  try {
    if (!existsSync(CACHE_PATH)) return null;
    const raw = JSON.parse(readFileSync(CACHE_PATH, "utf8")) as DailyNewsCache;
    if (raw.date !== dateKey) return null;
    return raw;
  } catch {
    return null;
  }
}

function saveCache(c: DailyNewsCache) {
  mkdirSync(dirname(CACHE_PATH), { recursive: true });
  writeFileSync(CACHE_PATH, JSON.stringify(c, null, 2));
}

async function sessionDeskRows() {
  const win = newsSessionWindow();
  const rows = await db
    .select({
      id: deskCommentaries.id,
      source: deskCommentaries.source,
      kind: deskCommentaries.kind,
      category: deskCommentaries.category,
      subject: deskCommentaries.subject,
      receivedAt: deskCommentaries.receivedAt,
      synopsis: deskCommentaries.synopsis,
      bodyPlain: deskCommentaries.bodyPlain,
      noiseScore: deskCommentaries.noiseScore,
      fromDomain: deskCommentaries.fromDomain,
      articlePublishedAt: deskCommentaries.articlePublishedAt,
      tickersMentioned: deskCommentaries.tickersMentioned,
      meta: deskCommentaries.meta,
    })
    .from(deskCommentaries)
    .where(sql`${deskCommentaries.receivedAt} >= (${win.startDatePt}::date AT TIME ZONE 'America/Los_Angeles')`)
    .orderBy(desc(deskCommentaries.receivedAt))
    .limit(80);
  return { win, rows };
}

function includeRow(r: {
  noiseScore: number | null;
  category: string | null;
  meta: unknown;
}): boolean {
  const meta = (r.meta ?? {}) as { includeInBrief?: boolean };
  if (typeof meta.includeInBrief === "boolean") return meta.includeInBrief;
  if ((r.noiseScore ?? 0) >= DESK_BRIEF_PREFS.noiseExcludeAtOrAbove) return false;
  if (r.category === "promo") return false;
  return true;
}

async function loadRecentFeedback(sessionDate: string, limit = 12) {
  try {
    return await db
      .select()
      .from(deskNewsFeedback)
      .where(eq(deskNewsFeedback.sessionDate, sessionDate))
      .orderBy(desc(deskNewsFeedback.createdAt))
      .limit(limit);
  } catch {
    return [];
  }
}

router.get("/desk-commentaries/daily-news", async (_req, res) => {
  try {
    await ingestDeskCommentaries({ sinceMs: Date.now() - 6 * 60 * 60 * 1000 }).catch(() => null);
    const { win, rows } = await sessionDeskRows();
    const included = rows.filter(includeRow);
    const cache = loadCache(win.dateKey);
    const maxReceivedAt = rows[0]?.receivedAt?.toISOString() ?? null;
    let newSince = 0;
    if (cache?.maxReceivedAt || cache?.generatedAt) {
      const sinceMs = new Date(cache.maxReceivedAt ?? cache.generatedAt).getTime();
      if (Number.isFinite(sinceMs)) {
        newSince = rows.filter((r) => r.receivedAt.getTime() > sinceMs).length;
      }
    } else {
      newSince = rows.length;
    }

    return res.json({
      date: win.dateKey,
      sessionStartPt: win.startDatePt,
      sessionLabel: win.label,
      isWeekendPack: win.isWeekendPack,
      todayCount: rows.length,
      includedCount: included.length,
      excludedCount: rows.length - included.length,
      maxReceivedAt,
      newSinceLastSummary: cache ? newSince : rows.length,
      summary: cache
        ? {
            content: cache.content,
            generatedAt: cache.generatedAt,
            emailCount: cache.emailCount,
            includedCount: cache.includedCount ?? cache.emailCount,
            maxReceivedAt: cache.maxReceivedAt,
            sources: cache.sources,
            categories: cache.categories ?? [],
            sessionStartPt: cache.sessionStartPt,
          }
        : null,
    });
  } catch (err: any) {
    return res.status(500).json({ error: String(err?.message ?? err) });
  }
});

router.post("/desk-commentaries/daily-news/refresh", requireAdmin, aiLimiter, async (req, res) => {
  try {
    await ensureDeskCommentariesTable().catch(() => null);
    await ingestDeskCommentaries({ sinceMs: Date.now() - 36 * 60 * 60 * 1000 }).catch(() => null);
    const { win, rows } = await sessionDeskRows();
    const included = rows.filter(includeRow);
    if (rows.length === 0) {
      return res.json({
        date: win.dateKey,
        sessionStartPt: win.startDatePt,
        sessionLabel: win.label,
        isWeekendPack: win.isWeekendPack,
        todayCount: 0,
        includedCount: 0,
        excludedCount: 0,
        newSinceLastSummary: 0,
        maxReceivedAt: null,
        summary: null,
        message: `No desk emails in ${win.label} yet.`,
      });
    }

    const pack = included
      .slice(0, 24)
      .map((r) => {
        const when = (r.articlePublishedAt ?? r.receivedAt).toISOString().replace("T", " ").slice(0, 16);
        const body = (r.synopsis || r.bodyPlain || "").slice(0, 420);
        const tickers = Array.isArray(r.tickersMentioned) && r.tickersMentioned.length
          ? `\nTickers: ${(r.tickersMentioned as string[]).slice(0, 8).join(", ")}`
          : "";
        const links = ((r.meta as { contentLinks?: Array<{ url: string }> } | null)?.contentLinks ?? [])
          .slice(0, 2)
          .map((l) => l.url)
          .join(" | ");
        return `[${r.category ?? r.kind}/${r.source} noise=${r.noiseScore ?? "?"}] ${when}\n${r.subject}\n${body}${tickers}${links ? `\nLinks: ${links}` : ""}`;
      })
      .join("\n\n---\n\n");

    const feedback = await loadRecentFeedback(win.dateKey);
    const feedbackBlock = feedback.length
      ? feedback
          .map((f) => {
            if (f.feedbackType === "not_relevant") {
              return `- NOT RELEVANT: "${(f.bulletText ?? "").slice(0, 160)}" reason: ${(f.reason ?? "").slice(0, 200)}`;
            }
            if (f.feedbackType === "ask_why") {
              return `- ASK WHY omitted: "${(f.question ?? "").slice(0, 200)}" context: ${(f.reason ?? "").slice(0, 160)}`;
            }
            if (f.feedbackType === "want_more") {
              return `- WANT MORE on: "${(f.question ?? f.bulletText ?? "").slice(0, 200)}"`;
            }
            return `- ${f.feedbackType}: ${(f.reason ?? f.question ?? "").slice(0, 200)}`;
          })
          .join("\n")
      : "(none yet)";

    const excludedN = rows.length - included.length;
    const prompt = `You are a markets desk assistant for a ${DESK_BRIEF_PREFS.role}.
Session: ${win.label} (PT date ${win.dateKey}).

WANT to surface:
${DESK_BRIEF_PREFS.want.map((w) => `- ${w}`).join("\n")}

AVOID / ignore:
${DESK_BRIEF_PREFS.avoid.map((w) => `- ${w}`).join("\n")}

User feedback from prior generates this session (honor these):
${feedbackBlock}

Rules:
- Max 8 bullets total across sections.
- Use ONLY facts present in DESK EMAILS — do not invent catalysts.
- Prefer actionable risk/opportunity language for option sellers.
- Keep under 220 words.
- ${excludedN} noisy/promo emails were already filtered out — do not ask for them.
- If weekend pack: emphasize week-ahead risk into Monday open.

Structure exactly:
## Overnight / Macro
## Cross-asset / Politics
## Sector & tickers
## Put-seller takeaway (1-2 bullets)

=== DESK EMAILS (${included.length} included / ${rows.length} total) ===
${pack || "(all emails filtered as noise — say so briefly)"}`;

    const { text: content } = await callHaiku({
      prompt,
      maxTokens: 500,
      trigger: "desk-daily-news",
      surfaceType: "desk-daily-news",
      userId: req.session.userId,
      ticker: "_",
    });
    const sources = [...new Set(included.map((r) => r.source))];
    const categories = [...new Set(included.map((r) => r.category ?? r.kind).filter(Boolean))] as string[];
    const maxReceivedAt = rows[0]?.receivedAt?.toISOString() ?? null;
    const cache: DailyNewsCache = {
      date: win.dateKey,
      sessionStartPt: win.startDatePt,
      content,
      generatedAt: new Date().toISOString(),
      emailCount: rows.length,
      includedCount: included.length,
      maxReceivedAt,
      sources,
      categories,
    };
    saveCache(cache);

    return res.json({
      date: win.dateKey,
      sessionStartPt: win.startDatePt,
      sessionLabel: win.label,
      isWeekendPack: win.isWeekendPack,
      todayCount: rows.length,
      includedCount: included.length,
      excludedCount: excludedN,
      newSinceLastSummary: 0,
      maxReceivedAt,
      summary: {
        content: cache.content,
        generatedAt: cache.generatedAt,
        emailCount: cache.emailCount,
        includedCount: cache.includedCount,
        maxReceivedAt: cache.maxReceivedAt,
        sources: cache.sources,
        categories: cache.categories,
        sessionStartPt: cache.sessionStartPt,
      },
    });
  } catch (err: any) {
    return res.status(500).json({ error: String(err?.message ?? err) });
  }
});

router.post("/desk-commentaries/daily-news/feedback", requireAdmin, async (req, res) => {
  try {
    await ensureDeskCommentariesTable();
    const win = newsSessionWindow();
    const feedbackType = String(req.body?.feedbackType ?? "");
    if (!["not_relevant", "ask_why", "want_more"].includes(feedbackType)) {
      return res.status(400).json({ error: "feedbackType must be not_relevant | ask_why | want_more" });
    }
    const [row] = await db
      .insert(deskNewsFeedback)
      .values({
        sessionDate: String(req.body?.sessionDate ?? win.dateKey),
        feedbackType,
        bulletText: req.body?.bulletText ? String(req.body.bulletText).slice(0, 500) : null,
        reason: req.body?.reason ? String(req.body.reason).slice(0, 800) : null,
        question: req.body?.question ? String(req.body.question).slice(0, 800) : null,
        meta: { source: "live_news_ui" },
      })
      .returning();
    return res.json({ ok: true, feedback: row });
  } catch (err: any) {
    return res.status(500).json({ error: String(err?.message ?? err) });
  }
});

router.get("/desk-commentaries/daily-news/feedback", requireAdmin, async (req, res) => {
  try {
    const win = newsSessionWindow();
    const sessionDate = String(req.query["sessionDate"] ?? win.dateKey);
    const rows = await loadRecentFeedback(sessionDate, 40);
    return res.json({ sessionDate, count: rows.length, items: rows });
  } catch (err: any) {
    return res.status(500).json({ error: String(err?.message ?? err) });
  }
});

export default router;
