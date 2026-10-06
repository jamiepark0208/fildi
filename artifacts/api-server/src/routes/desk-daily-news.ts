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
import { and, desc, eq, gte, isNull, lte, sql } from "drizzle-orm";
import { db, deskCommentaries, deskNewsFeedback, earningsCalendar, positions, watchlist } from "@workspace/db";
import { requireAdmin } from "../middleware/requireAdmin.js";
import { aiLimiter } from "../middleware/rateLimiter.js";
import { callHaiku } from "../lib/haiku.js";
import { ingestDeskCommentaries, ensureDeskCommentariesTable } from "../lib/desk-commentary.js";
import {
  DESK_BRIEF_PREFS,
  extractTickersClean,
  newsSessionWindow,
} from "../lib/desk-commentary-normalize.js";
import {
  digDeskItem,
  filterDisplayDigFacts,
  formatDigFactsForPrompt,
  type DigFact,
} from "../lib/desk-link-dig.js";
import { enrichShallowDigFacts } from "../lib/desk-dig-enrich.js";
import {
  assessDailyNewsQuality,
  sanitizeDailyNewsContent,
} from "../lib/desk-daily-news-quality.js";

async function loadBookTickers(userId: number | undefined): Promise<{
  watch: string[];
  book: string[];
  all: Set<string>;
  promptBlock: string;
}> {
  if (userId == null) {
    return { watch: [], book: [], all: new Set(), promptBlock: "(no user — skip book bias)" };
  }
  const [wl, open] = await Promise.all([
    db.select({ ticker: watchlist.ticker })
      .from(watchlist)
      .where(eq(watchlist.userId, userId))
      .limit(80),
    db.select({ ticker: positions.ticker, positionType: positions.positionType })
      .from(positions)
      .where(and(eq(positions.userId, userId), isNull(positions.closedAt)))
      .limit(40),
  ]);
  const watch = [...new Set(wl.map((r) => r.ticker.toUpperCase()))].slice(0, 40);
  const book = [...new Set(open.map((r) => r.ticker.toUpperCase()))].slice(0, 25);
  const shorts = open
    .filter((r) => r.positionType === "short_put" || r.positionType === "short_call")
    .map((r) => `${r.ticker.toUpperCase()}(${r.positionType === "short_put" ? "SP" : "SC"})`);
  const shortUniq = [...new Set(shorts)].slice(0, 20);
  const all = new Set([...watch, ...book]);
  return {
    watch,
    book,
    all,
    promptBlock: [
      `Open positions: ${book.length ? book.join(", ") : "(none)"}`,
      shortUniq.length ? `Short options: ${shortUniq.join(", ")}` : null,
      `Watchlist: ${watch.length ? watch.join(", ") : "(empty)"}`,
    ].filter(Boolean).join("\n"),
  };
}

async function loadNearEarnings(book: Set<string>): Promise<string> {
  if (book.size === 0) return "(none in book)";
  const today = new Date();
  const start = today.toISOString().slice(0, 10);
  const end = new Date(today.getTime() + 14 * 86_400_000).toISOString().slice(0, 10);
  const rows = await db
    .select({
      ticker: earningsCalendar.ticker,
      reportDate: earningsCalendar.reportDate,
    })
    .from(earningsCalendar)
    .where(and(
      gte(earningsCalendar.reportDate, start),
      lte(earningsCalendar.reportDate, end),
    ))
    .limit(200);
  const hits = rows
    .filter((r) => book.has(r.ticker.toUpperCase()))
    .slice(0, 12)
    .map((r) => `${r.ticker.toUpperCase()} ${r.reportDate}`);
  return hits.length ? hits.join(", ") : "(none in book next 14d)";
}

interface DeskRowLite {
  id: number;
  source: string;
  kind: string;
  category: string | null;
  subject: string;
  receivedAt: Date;
  synopsis: string | null;
  bodyPlain: string | null;
  noiseScore: number | null;
  articlePublishedAt: Date | null;
  tickersMentioned: unknown;
  meta: unknown;
}

function rowTickers(r: DeskRowLite): string[] {
  const fromJson = Array.isArray(r.tickersMentioned)
    ? (r.tickersMentioned as string[]).map((t) => String(t).toUpperCase())
    : [];
  const fromText = extractTickersClean(`${r.subject}\n${r.synopsis ?? ""}\n${(r.bodyPlain ?? "").slice(0, 1200)}`);
  return [...new Set([...fromText, ...fromJson])].filter((t) => /^[A-Z]{1,5}$/.test(t));
}

/** Rank for packing: book hits + diggable activity + category priors. */
function rankForPack(r: DeskRowLite, book: Set<string>, digCount: number): number {
  const tickers = rowTickers(r);
  const hits = tickers.filter((t) => book.has(t)).length;
  let score = hits * 40 + digCount * 25;
  if (/watchlist|new activity|analyst|price target/i.test(r.subject)) score += 35;
  if (/portfolio digest|top gainers|top losers/i.test(r.subject + (r.synopsis ?? ""))) score += 30;
  if (r.category === "macro" || r.category === "overnight") score += 12;
  if (r.category === "politics") score += 8;
  if (r.category === "earnings") score += 10;
  if (r.source === "factset_streetaccount" || r.source === "factset") score += 8;
  score -= Math.min(30, (r.noiseScore ?? 0) / 4);
  return score;
}

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
  digFacts?: DigFact[];
  bookHits?: string[];
  earningsNear?: string;
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
            digFacts: filterDisplayDigFacts(cache.digFacts ?? []),
            bookHits: cache.bookHits ?? [],
            earningsNear: cache.earningsNear ?? "",
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

    const book = await loadBookTickers(req.session.userId);
    const earningsNear = await loadNearEarnings(book.all).catch(() => "(earnings lookup failed)");

    const digCandidates = included
      .filter((r) =>
        /watchlist|new activity|analyst|price target|rating|portfolio digest|continue reading/i.test(
          `${r.subject} ${r.synopsis ?? ""}`,
        )
        || rowTickers(r).some((t) => book.all.has(t)),
      )
      .slice(0, 10);

    const digById = new Map<number, DigFact[]>();
    let allDigFacts: DigFact[] = [];
    for (const r of digCandidates) {
      const meta = (r.meta ?? {}) as { contentLinks?: Array<{ url: string }> };
      const facts = await digDeskItem({
        source: r.source,
        subject: r.subject,
        bodyPlain: r.bodyPlain,
        synopsis: r.synopsis,
        contentLinks: meta.contentLinks,
      });
      digById.set(r.id, facts);
      allDigFacts.push(...facts);
    }

    // TipRanks emails only say "N new ratings" — dig Yahoo for firm/grade/date.
    allDigFacts = await enrichShallowDigFacts(allDigFacts, { sinceDate: win.startDatePt });
    // Re-attach enriched facts onto digById for pack DIG lines (by ticker).
    const enrichedByTicker = new Map<string, DigFact[]>();
    for (const f of allDigFacts) {
      const list = enrichedByTicker.get(f.ticker) ?? [];
      list.push(f);
      enrichedByTicker.set(f.ticker, list);
    }
    for (const [id, facts] of digById) {
      const tickers = new Set(facts.map((f) => f.ticker));
      const merged = [...facts];
      for (const t of tickers) {
        for (const f of enrichedByTicker.get(t) ?? []) {
          if (!merged.some((m) => m.detail === f.detail && m.source === f.source)) merged.push(f);
        }
      }
      digById.set(id, merged);
    }

    const ranked = [...included]
      .map((r) => ({ r, score: rankForPack(r, book.all, digById.get(r.id)?.length ?? 0) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, 18)
      .map(({ r }) => r);

    const pack = ranked
      .map((r) => {
        const when = (r.articlePublishedAt ?? r.receivedAt).toISOString().replace("T", " ").slice(0, 16);
        const body = (r.synopsis || r.bodyPlain || "").slice(0, 720);
        const tickers = rowTickers(r);
        const dig = digById.get(r.id) ?? [];
        const digLine = dig.length
          ? `\nDIG: ${dig.map((f) => `${f.ticker} ${f.kind} ${f.detail}`).join("; ")}`
          : "";
        return `[${r.category ?? r.kind}/${r.source} noise=${r.noiseScore ?? "?"}] ${when}\n${r.subject}\n${body}${
          tickers.length ? `\nTickers: ${tickers.slice(0, 10).join(", ")}` : ""
        }${digLine}`;
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
    const digBlock = formatDigFactsForPrompt(allDigFacts);
    const bookHits = [...new Set(allDigFacts.map((f) => f.ticker).filter((t) => book.all.has(t)))];
    const bookCtx = book.promptBlock;
    const promptBase = `You write a pre-market / session DESK COMMENTARY for a ${DESK_BRIEF_PREFS.role}.
This is NOT a list of rating chips. It is a short morning-meeting note: what the tape is doing, why, what matters into the cash session, and what a put-seller should do with that.

Session: ${win.label} (PT date ${win.dateKey}).

A good daily stock-market commentary has:
1) Tape / open bias — futures or cash indices, risk-on vs risk-off in one line with levels/%
2) Macro drivers — rates/Fed, oil/energy, credit/VIX/USD when the emails mention them (numbers stay)
3) Cross-asset or politics only if path-to-markets is clear
4) Sector / single-name catalysts from the emails (earnings, upgrades with firm+grade, movers)
5) Put-seller takeaway — bias for short premium: lean in / stay light / watch IV into named events

WANT to surface:
${DESK_BRIEF_PREFS.want.map((w) => `- ${w}`).join("\n")}

AVOID / ignore:
${DESK_BRIEF_PREFS.avoid.map((w) => `- ${w}`).join("\n")}
- TipRanks/email teasers that only say "N new analyst rating(s)" with no firm, grade, upgrade/downgrade, or PT — NEVER surface those.
- Empty sections. Do not leave a heading with zero bullets.

BOOK CONTEXT (priority bias only — do NOT invent news about these names):
${bookCtx}
- Prefer desk facts that touch open shorts / watchlist tickers.
- Macro-only items still belong when they move vol/rates for the book.

NEAR EARNINGS (book ∩ next 14d):
${earningsNear}

SECONDARY DIG (analyst/PT — firm/grade/date when present; ground truth, not the whole brief):
${digBlock}

User feedback from prior generates this session (honor these):
${feedbackBlock}

Rules:
- 6–10 bullets total across sections. Overnight/Macro MUST have ≥2 bullets if any macro/overnight email is in the pack.
- EACH bullet: start with "- " then **Lead fact with number** — one short clause (≤28 words).
- Tickers in CAPS. *italics* only for caveats.
- MUST include confirmed DIG (firm/grade/PT) that touch the book; dig is a supporting strip, not a substitute for macro.
- NEVER write "N new analyst rating(s)" or "Monitor TipRanks".
- Use ONLY facts in DESK EMAILS / DIG — do not invent levels, firms, or sectors.
- Put-seller takeaway is mandatory when there is any usable tape/macro (1–2 bullets).
- Keep under 220 words total.
- ${excludedN} noisy/promo emails were already filtered out — do not ask for them.
- If weekend pack: emphasize week-ahead risk into Monday open.

Structure exactly (omit a heading only if truly zero bullets for that theme):
## Overnight / Macro
## Cross-asset / Politics
## Sector & tickers
## Put-seller takeaway

=== DESK EMAILS (top ${ranked.length} of ${included.length} included / ${rows.length} total) ===
${pack || "(all emails filtered as noise — say so briefly)"}`;

    let content = (
      await callHaiku({
        prompt: promptBase,
        maxTokens: 420,
        trigger: "desk-daily-news",
        surfaceType: "desk-daily-news",
        userId: req.session.userId,
        ticker: "_",
      })
    ).text;

    let quality = assessDailyNewsQuality(content);
    if (!quality.ok) {
      content = (
        await callHaiku({
          prompt: `${promptBase}

QUALITY FAIL on prior draft — rewrite and fix: ${quality.reasons.join("; ")}.
Prior draft (do not repeat its mistakes):
${content.slice(0, 600)}`,
          maxTokens: 420,
          trigger: "desk-daily-news-retry",
          surfaceType: "desk-daily-news",
          userId: req.session.userId,
          ticker: "_",
        })
      ).text;
      quality = assessDailyNewsQuality(content);
    }
    if (!quality.ok) {
      content = sanitizeDailyNewsContent(content);
      if (!content.trim()) {
        content =
          "## Overnight / Macro\n**Desk pack thin on confirmed catalysts** — macro emails only; analyst teasers omitted pending firm/grade.\n\n## Put-seller takeaway\nNo actionable rating detail confirmed; lean on levels from macro pack, not TipRanks counts.";
      }
    }

    const sources = [...new Set(ranked.map((r) => r.source))];
    const categories = [...new Set(ranked.map((r) => r.category ?? r.kind).filter(Boolean))] as string[];
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
      digFacts: filterDisplayDigFacts(allDigFacts).slice(0, 24),
      bookHits,
      earningsNear,
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
        digFacts: cache.digFacts,
        bookHits,
        earningsNear,
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
