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
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { and, desc, eq, gte, isNull, lte, sql } from "drizzle-orm";
import {
  db,
  deskCommentaries,
  deskNewsFeedback,
  earningsCalendar,
  portfolioPositions,
  portfolioSnapshots,
  positions,
  watchlist,
} from "@workspace/db";
import { requireAdmin } from "../middleware/requireAdmin.js";
import { requireAuth } from "../middleware/requireAuth.js";
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

export interface EarningsNearRow {
  date: string;
  tickers: string[];
  /** book = watchlist∪holdings∪positions; market = notable majors outside the book */
  scope?: "book" | "market";
}

/** Majors we surface even when not on the book (banks / mega-cap prints). */
const MARKET_EARNINGS_MAJORS = new Set([
  "JPM", "BAC", "C", "WFC", "GS", "MS", "USB", "PNC", "TFC",
  "AAPL", "MSFT", "GOOGL", "GOOG", "AMZN", "META", "NVDA", "TSLA", "NFLX",
  "TSM", "AVGO", "AMD", "INTC", "JNJ", "UNH", "XOM", "CVX",
]);

export interface ModelContractRow {
  ticker: string;
  side: string;
  strike: number | null;
  expiry: string | null;
  premium: number | null;
  folder: string;
  verdict: string;
  status: string;
}

async function loadBookTickers(userId: number | undefined): Promise<{
  watch: string[];
  book: string[];
  holdings: string[];
  all: Set<string>;
  promptBlock: string;
}> {
  if (userId == null) {
    return {
      watch: [], book: [], holdings: [], all: new Set(),
      promptBlock: "(no user — skip book bias)",
    };
  }
  const [wl, open, latestSnap] = await Promise.all([
    db.select({ ticker: watchlist.ticker })
      .from(watchlist)
      .where(eq(watchlist.userId, userId))
      .limit(80),
    db.select({ ticker: positions.ticker, positionType: positions.positionType })
      .from(positions)
      .where(and(eq(positions.userId, userId), isNull(positions.closedAt)))
      .limit(40),
    db.select({ id: portfolioSnapshots.id })
      .from(portfolioSnapshots)
      .orderBy(desc(portfolioSnapshots.id))
      .limit(1),
  ]);
  const snapId = latestSnap[0]?.id;
  const holdRows = snapId == null
    ? []
    : await db.select({ symbol: portfolioPositions.symbol })
      .from(portfolioPositions)
      .where(eq(portfolioPositions.snapshotId, snapId))
      .limit(80);
  const watch = [...new Set(wl.map((r) => r.ticker.toUpperCase()))].slice(0, 40);
  const book = [...new Set(open.map((r) => r.ticker.toUpperCase()))].slice(0, 25);
  const holdings = [...new Set(
    holdRows
      .map((r) => r.symbol.toUpperCase())
      .filter((t) => /^[A-Z]{1,5}$/.test(t)),
  )].slice(0, 40);
  const shorts = open
    .filter((r) => r.positionType === "short_put" || r.positionType === "short_call")
    .map((r) => `${r.ticker.toUpperCase()}(${r.positionType === "short_put" ? "SP" : "SC"})`);
  const shortUniq = [...new Set(shorts)].slice(0, 20);
  const all = new Set([...watch, ...book, ...holdings]);
  return {
    watch,
    book,
    holdings,
    all,
    promptBlock: [
      `Open positions: ${book.length ? book.join(", ") : "(none)"}`,
      shortUniq.length ? `Short options: ${shortUniq.join(", ")}` : null,
      `Portfolio holdings: ${holdings.length ? holdings.join(", ") : "(none)"}`,
      `Watchlist: ${watch.length ? watch.join(", ") : "(empty)"}`,
    ].filter(Boolean).join("\n"),
  };
}

function reportDateKey(d: unknown): string {
  if (d instanceof Date) return d.toISOString().slice(0, 10);
  const s = String(d ?? "");
  return /^\d{4}-\d{2}-\d{2}/.test(s) ? s.slice(0, 10) : s;
}

async function loadNearEarnings(book: Set<string>): Promise<{
  text: string;
  rows: EarningsNearRow[];
  marketRows: EarningsNearRow[];
}> {
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
    .limit(400);

  const bookByDate = new Map<string, string[]>();
  const mktByDate = new Map<string, string[]>();
  for (const r of rows) {
    const t = r.ticker.toUpperCase();
    const key = reportDateKey(r.reportDate);
    if (book.has(t)) {
      const list = bookByDate.get(key) ?? [];
      if (!list.includes(t)) list.push(t);
      bookByDate.set(key, list);
    } else if (MARKET_EARNINGS_MAJORS.has(t)) {
      const list = mktByDate.get(key) ?? [];
      if (!list.includes(t)) list.push(t);
      mktByDate.set(key, list);
    }
  }
  const grouped: EarningsNearRow[] = [...bookByDate.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, tickers]) => ({ date, tickers: tickers.sort(), scope: "book" as const }));
  const marketRows: EarningsNearRow[] = [...mktByDate.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, tickers]) => ({ date, tickers: tickers.sort(), scope: "market" as const }));
  const text = grouped.length
    ? grouped.map((g) => `${g.date}: ${g.tickers.join(", ")}`).join("; ")
    : "(none in book next 14d)";
  const mktText = marketRows.length
    ? marketRows.map((g) => `${g.date}: ${g.tickers.join(", ")}`).join("; ")
    : "(none)";
  return {
    text: `BOOK: ${text}\nMAJORS (not in book): ${mktText}`,
    rows: grouped,
    marketRows,
  };
}

type SqlRows<T> = { rows?: T[] } | T[];
const rowsOf = <T,>(r: SqlRows<T>): T[] => (Array.isArray(r) ? r : r.rows ?? []);

/** Latest Model List contracts for book tickers — ground truth for put-seller takeaway. */
async function loadModelContracts(tickers: Set<string>): Promise<{
  text: string;
  rows: ModelContractRow[];
}> {
  if (tickers.size === 0) return { text: "(no book tickers)", rows: [] };
  const list = [...tickers];
  const items = rowsOf(await db.execute(sql`
    SELECT i.ticker, i.folder_key, i.verdict, i.status, i.contract
    FROM watchlist_sync.model_items i
    WHERE i.run_id = (SELECT MAX(id) FROM watchlist_sync.model_runs)
      AND UPPER(i.ticker) IN (${sql.join(list.map((t) => sql`${t}`), sql`, `)})
    ORDER BY i.ticker, i.folder_key
  `) as SqlRows<{
    ticker: string;
    folder_key: string;
    verdict: string | null;
    status: string | null;
    contract: Record<string, unknown> | null;
  }>);

  const prefer = (folder: string) => {
    const f = folder.toLowerCase();
    if (f.includes("sell_put") || f === "income") return 0;
    if (f.includes("manage") || f.includes("trim")) return 1;
    if (f.includes("sell_call") || f.includes("call")) return 2;
    if (f.includes("avoid") || f.includes("rebalance")) return 3;
    return 4;
  };

  const best = new Map<string, ModelContractRow>();
  const notes: string[] = [];
  for (const it of items) {
    const t = String(it.ticker).toUpperCase();
    const c = it.contract && typeof it.contract === "object" ? it.contract : null;
    const side = c?.type != null ? String(c.type).toLowerCase() : "";
    if (side === "put" || side === "call") {
      const row: ModelContractRow = {
        ticker: t,
        side,
        strike: typeof c?.strike === "number" ? c.strike : c?.strike != null ? Number(c.strike) : null,
        expiry: c?.expiry != null ? String(c.expiry).slice(0, 10) : null,
        premium: typeof c?.premium === "number" ? c.premium : c?.premium != null ? Number(c.premium) : null,
        folder: String(it.folder_key),
        verdict: String(it.verdict ?? ""),
        status: String(it.status ?? ""),
      };
      const prev = best.get(t);
      if (!prev || prefer(row.folder) < prefer(prev.folder)) best.set(t, row);
    } else if (it.verdict === "red" || /avoid|trim_risk|rebalance/i.test(String(it.folder_key))) {
      notes.push(`${t}: ${it.folder_key}${it.verdict ? `/${it.verdict}` : ""} — no sellable model contract`);
    }
  }

  const rows = [...best.values()].sort((a, b) => a.ticker.localeCompare(b.ticker));
  const lines = rows.map((r) => {
    const prem = r.premium != null && Number.isFinite(r.premium) ? ` @ $${r.premium}` : "";
    const strike = r.strike != null && Number.isFinite(r.strike) ? `$${r.strike}` : "?";
    return `${r.ticker}: sell ${r.side} ${strike} exp ${r.expiry ?? "?"}${prem} (${r.folder}${r.verdict ? `, ${r.verdict}` : ""}${r.status ? `, ${r.status}` : ""})`;
  });
  const uniqNotes = [...new Set(notes)].slice(0, 12);
  const text = [...lines, ...uniqNotes].join("\n") || "(no model contracts for book)";
  return { text, rows };
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
/** Repo-root `commentary/` — Muse AM/PM briefs (A45). */
const COMMENTARY_DIR = join(__dir, "..", "..", "..", "..", "commentary");

export interface MuseBrief {
  edition: "am" | "pm";
  file: string;
  title: string;
  banner: string;
  /** Concise bullets for the Daily News top strip */
  bullets: string[];
  /** Truncated raw markdown for Haiku skeleton (not full file) */
  promptExcerpt: string;
  /** Brief calendar day YYYY-MM-DD (from dated filename or title) */
  asOfYmd: string | null;
  /** Content fingerprint — materiality must compare this, not latest-am|pm filename (A70) */
  contentHash: string;
  /** True when asOfYmd is before the current Daily News session date (A62) */
  stale: boolean;
}

/** A65: GET polls every ~60s — don't hit Gmail/Drive each time. POST refresh always ingests. */
const DESK_INGEST_MIN_MS = 15 * 60 * 1000;
let lastDeskIngestAt = 0;

async function maybeIngestDeskOnGet(): Promise<void> {
  const now = Date.now();
  if (now - lastDeskIngestAt < DESK_INGEST_MIN_MS) return;
  lastDeskIngestAt = now;
  await ingestDeskCommentaries({ sinceMs: now - 6 * 60 * 60 * 1000 }).catch(() => null);
}

function ptHourNow(): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Los_Angeles",
    hour: "numeric",
    hour12: false,
  }).formatToParts(new Date());
  return Number(parts.find((p) => p.type === "hour")?.value ?? "12");
}

const MONTHS: Record<string, string> = {
  january: "01", february: "02", march: "03", april: "04", may: "05", june: "06",
  july: "07", august: "08", september: "09", october: "10", november: "11", december: "12",
};

/** Resolve brief day from dated `YYYY-MM-DD-am|pm.md` sibling or title ("October 12, 2026"). */
function resolveBriefAsOfYmd(edition: "am" | "pm", title: string, contentHash: string): string | null {
  try {
    const dated = readdirSync(COMMENTARY_DIR)
      .map((n) => {
        const m = n.match(/^(\d{4}-\d{2}-\d{2})-(am|pm)\.md$/i);
        if (!m || m[2]!.toLowerCase() !== edition) return null;
        const p = join(COMMENTARY_DIR, n);
        try {
          const h = createHash("sha256").update(readFileSync(p, "utf8")).digest("hex").slice(0, 16);
          return h === contentHash ? m[1]! : null;
        } catch {
          return null;
        }
      })
      .filter((x): x is string => !!x)
      .sort()
      .at(-1);
    if (dated) return dated;
  } catch { /* ignore */ }

  const m = title.match(
    /\b(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{1,2}),\s*(\d{4})\b/i,
  );
  if (!m) return null;
  const mo = MONTHS[m[1]!.toLowerCase()];
  if (!mo) return null;
  return `${m[3]}-${mo}-${String(m[2]).padStart(2, "0")}`;
}

/** Prefer PM after 1pm PT; fall back to the other edition if missing. */
function loadMuseBrief(sessionDateKey?: string): MuseBrief | null {
  try {
    if (!existsSync(COMMENTARY_DIR)) return null;
    const preferPm = ptHourNow() >= 13;
    const order: Array<"am" | "pm"> = preferPm ? ["pm", "am"] : ["am", "pm"];
    for (const edition of order) {
      const file = edition === "am" ? "latest-am.md" : "latest-pm.md";
      const path = join(COMMENTARY_DIR, file);
      if (!existsSync(path)) continue;
      const raw = readFileSync(path, "utf8");
      if (raw.trim().length < 80) continue;
      const contentHash = createHash("sha256").update(raw).digest("hex").slice(0, 16);
      const lines = raw.split("\n");
      const title = (lines.find((l) => l.startsWith("# ")) ?? "").replace(/^#\s+/, "").trim()
        || (edition === "am" ? "Morning market brief" : "Evening market recap");
      const bannerLine = lines.find((l) => /^\*\*Banner:\*\*/i.test(l) || /^\*\*S&P\b/i.test(l))
        ?? lines.find((l) => l.startsWith("**") && l.includes("·"));
      const banner = (bannerLine ?? "")
        .replace(/^\*\*Banner:\*\*\s*/i, "")
        .replace(/^\*\*|\*\*$/g, "")
        .trim();

      const sectionBullets = (headingRe: RegExp, max: number): string[] => {
        const out: string[] = [];
        let inSec = false;
        for (const line of lines) {
          if (line.startsWith("## ")) {
            inSec = headingRe.test(line);
            continue;
          }
          if (!inSec) continue;
          if (line.startsWith("## ")) break;
          const m = line.match(/^-\s+\*\*(.+?)\*\*\.?\s*(.*)$/) ?? line.match(/^-\s+(.+)$/);
          if (!m) continue;
          const text = m[2] != null
            ? `${m[1]}${m[2] ? ` — ${m[2].replace(/\s*\[[^\]]+\]/g, "").trim()}` : ""}`
            : m[1]!.replace(/\s*\[[^\]]+\]/g, "").trim();
          const clean = text.replace(/\s+/g, " ").trim();
          if (clean.length >= 20) out.push(clean.length > 180 ? `${clean.slice(0, 177)}…` : clean);
          if (out.length >= max) break;
        }
        return out;
      };

      const moving = sectionBullets(/what'?s moving|what moved/i, 3);
      const why = sectionBullets(/why it matters/i, 2);
      const impl = sectionBullets(/implications/i, 2);
      const bullets = [...moving, ...why, ...impl].slice(0, 6);
      if (!bullets.length && !banner) continue;

      // Skeleton for Haiku: banner + moving + why + implications (cap size)
      const keepHeadings = /^(# |## What's moving|## What moved|## Why it matters|## Implications|\*\*Banner|\*\*S&P|- )/i;
      const excerptLines: string[] = [];
      let chars = 0;
      for (const line of lines) {
        if (!keepHeadings.test(line) && !line.startsWith("- ")) {
          if (line.startsWith("## ")) {
            if (/^##\s+(Data|Single|Context|Breadth|What to watch)/i.test(line)) break;
          }
          continue;
        }
        if (/^##\s+(Data|Single|Context|Breadth|What to watch|Sources)/i.test(line)) break;
        excerptLines.push(line);
        chars += line.length;
        if (chars > 2200) break;
      }

      const asOfYmd = resolveBriefAsOfYmd(edition, title, contentHash)
        ?? (() => {
          try {
            const d = new Date(statSync(path).mtimeMs);
            return d.toLocaleDateString("en-CA", { timeZone: "America/Los_Angeles" });
          } catch {
            return null;
          }
        })();
      const stale = !!sessionDateKey && (!asOfYmd || asOfYmd < sessionDateKey);

      return {
        edition,
        file,
        title,
        banner,
        bullets,
        promptExcerpt: excerptLines.join("\n").slice(0, 2400),
        asOfYmd,
        contentHash,
        stale,
      };
    }
    return null;
  } catch {
    return null;
  }
}

interface BannerLevel {
  key: string; // es | ym | nq | brent | tnx | vix
  value: number; // % change (or yield level for tnx)
  kind: "pct" | "yield";
}

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
  earningsNearRows?: EarningsNearRow[];
  marketEarningsRows?: EarningsNearRow[];
  modelContracts?: ModelContractRow[];
  /** A45 edition stamp */
  editionId?: string;
  museFile?: string | null;
  museBanner?: string | null;
  /** A70 — content fingerprint of Muse brief when Desk adds were generated */
  museContentHash?: string | null;
  bannerLevels?: BannerLevel[];
}

function parseBannerLevels(banner: string | null | undefined): BannerLevel[] {
  if (!banner) return [];
  const out: BannerLevel[] = [];
  const parts = banner.split(/\s*[·|]\s*/);
  for (const part of parts) {
    const p = part.trim();
    const pct = p.match(/([+\u2212\u2013\-]\s*\d+(?:\.\d+)?)\s*%/);
    const yieldM = p.match(/\b10\s*Y\b.*?(\d+\.\d+)\s*%?/i);
    let key = "";
    if (/S&P\s*fut|ES\b/i.test(p)) key = "es";
    else if (/Dow\s*fut|YM\b/i.test(p)) key = "ym";
    else if (/Nasdaq|NQ\b/i.test(p)) key = "nq";
    else if (/Brent/i.test(p)) key = "brent";
    else if (/\bVIX\b/i.test(p)) key = "vix";
    else if (/\b10\s*Y\b/i.test(p)) key = "tnx";
    if (!key) continue;
    if (key === "tnx" && yieldM) {
      out.push({ key, value: parseFloat(yieldM[1]!), kind: "yield" });
    } else if (pct) {
      const n = parseFloat(pct[1]!.replace(/[\u2212\u2013]/g, "-"));
      if (Number.isFinite(n)) out.push({ key, value: n, kind: "pct" });
    }
  }
  return out;
}

function bannerMovedMaterial(prev: BannerLevel[] | undefined, next: BannerLevel[]): string[] {
  if (!prev?.length || !next.length) return [];
  const by = new Map(prev.map((b) => [b.key, b]));
  const reasons: string[] = [];
  const thr: Record<string, number> = { es: 0.5, ym: 0.5, nq: 0.5, brent: 2, vix: 2 };
  for (const n of next) {
    const p = by.get(n.key);
    if (!p) continue;
    if (n.kind === "yield" && p.kind === "yield") {
      const bp = Math.abs(n.value - p.value) * 100;
      if (bp >= 5) reasons.push(`10Y ${bp.toFixed(0)}bp`);
    } else if (n.kind === "pct" && p.kind === "pct") {
      const lim = thr[n.key] ?? 0.5;
      if (Math.abs(n.value - p.value) >= lim) {
        reasons.push(`${n.key.toUpperCase()} Δ${(n.value - p.value).toFixed(1)}%`);
      }
    }
  }
  return reasons;
}

function formatPtShort(iso: string | null | undefined): string {
  if (!iso) return "?";
  try {
    return new Intl.DateTimeFormat("en-US", {
      timeZone: "America/Los_Angeles",
      hour: "numeric",
      minute: "2-digit",
    }).format(new Date(iso));
  } catch {
    return iso.slice(11, 16);
  }
}

function digCandidateSubject(subject: string, synopsis: string | null): boolean {
  return /watchlist|new activity|analyst|price target|rating|portfolio digest|continue reading/i.test(
    `${subject} ${synopsis ?? ""}`,
  );
}

function assessMateriality(opts: {
  cache: DailyNewsCache | null;
  rows: Array<{
    receivedAt: Date;
    subject: string;
    synopsis: string | null;
    tickersMentioned: unknown;
    noiseScore: number | null;
    category: string | null;
    meta: unknown;
  }>;
  included: Array<{
    receivedAt: Date;
    subject: string;
    synopsis: string | null;
    tickersMentioned: unknown;
  }>;
  newSince: number;
  museBrief: MuseBrief | null;
  book: Set<string> | null;
}): { material: boolean; reasons: string[]; statusLine: string; editionId: string | null } {
  const { cache, rows, included, newSince, museBrief, book } = opts;
  const reasons: string[] = [];
  const editionId = cache?.editionId
    ?? (cache ? `${cache.date}:${cache.generatedAt}` : null);

  if (!cache) {
    return {
      material: true,
      reasons: ["no prior Desk adds"],
      statusLine: `${included.length} emails ready · no Desk adds yet`,
      editionId: null,
    };
  }

  // A70: filename is always latest-am|pm — compare content hash (or banner) for same-edition updates.
  if (museBrief?.contentHash && cache.museContentHash && museBrief.contentHash !== cache.museContentHash) {
    reasons.push(`Muse ${museBrief.edition} brief updated`);
  } else if (museBrief?.file && cache.museFile && museBrief.file !== cache.museFile) {
    reasons.push(`new Muse ${museBrief.edition}`);
  } else if (museBrief?.banner && cache.museBanner && museBrief.banner !== cache.museBanner) {
    reasons.push("Muse banner changed");
  }

  const nextLevels = parseBannerLevels(museBrief?.banner);
  reasons.push(...bannerMovedMaterial(cache.bannerLevels, nextLevels));

  if (newSince > 0) {
    const sinceMs = new Date(cache.maxReceivedAt ?? cache.generatedAt).getTime();
    const fresh = included.filter((r) => r.receivedAt.getTime() > sinceMs);
    const bookHit = book
      ? fresh.some((r) =>
          extractTickersClean(`${r.subject} ${r.synopsis ?? ""}`).some((t) => book.has(t))
          || (Array.isArray(r.tickersMentioned)
            && (r.tickersMentioned as string[]).some((t) => book.has(String(t).toUpperCase()))),
        )
      : false;
    const digHit = fresh.some((r) => digCandidateSubject(r.subject, r.synopsis));
    if (bookHit) reasons.push(`${fresh.length} new · book hit`);
    else if (digHit) reasons.push(`${fresh.length} new · diggable`);
    else if (fresh.length >= 3) reasons.push(`${fresh.length} new emails`);
    else if (fresh.length > 0) {
      // noise-only trickle — not material alone
    }
  }

  const material = reasons.length > 0;
  const museBit = museBrief ? `Muse ${museBrief.edition}` : "no Muse";
  const statusLine = material
    ? `${reasons.slice(0, 3).join(" · ")} · last Desk adds ${formatPtShort(cache.generatedAt)}`
    : `No material update since ${formatPtShort(cache.generatedAt)} · ${museBit}`
      + (newSince > 0 ? ` · ${newSince} new (noise/covered)` : "");

  return { material, reasons, statusLine, editionId };
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

router.get("/desk-commentaries/daily-news", requireAuth, async (req, res) => {
  try {
    // A65: serve DB + cache; ingest at most every 15 min (POST refresh still always ingests).
    await maybeIngestDeskOnGet();
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

    // Live book earnings + model contracts + Muse brief (cheap) so UI is fresh without Haiku refresh.
    const book = await loadBookTickers(req.session.userId).catch(() => null);
    const liveEarn = book
      ? await loadNearEarnings(book.all).catch(() => null)
      : null;
    const liveModel = book
      ? await loadModelContracts(book.all).catch(() => null)
      : null;
    const museBriefRaw = loadMuseBrief(win.dateKey);
    // A62: don't present a prior-day brief as today's — null it on weekday sessions when stale.
    const museBrief = museBriefRaw && museBriefRaw.stale && !win.isWeekendPack
      ? null
      : museBriefRaw;
    const material = assessMateriality({
      cache,
      rows,
      included,
      newSince: cache ? newSince : rows.length,
      museBrief: museBriefRaw,
      book: book?.all ?? null,
    });
    const statusLine = museBriefRaw?.stale && !win.isWeekendPack
      ? `No brief yet today · last Muse ${museBriefRaw.asOfYmd ?? "?"} ${museBriefRaw.edition} · ${material.statusLine}`
      : material.statusLine;

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
      statusLine,
      editionId: material.editionId ?? cache?.editionId ?? null,
      materialSuggested: material.material,
      materialReasons: material.reasons,
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
            earningsNear: liveEarn?.text ?? cache.earningsNear ?? "",
            earningsNearRows: liveEarn?.rows ?? cache.earningsNearRows ?? [],
            marketEarningsRows: liveEarn?.marketRows ?? cache.marketEarningsRows ?? [],
            modelContracts: liveModel?.rows ?? cache.modelContracts ?? [],
            editionId: cache.editionId ?? null,
          }
        : null,
      // Available even before first Haiku generate
      earningsNearRows: liveEarn?.rows ?? [],
      marketEarningsRows: liveEarn?.marketRows ?? [],
      modelContracts: liveModel?.rows ?? [],
      museBrief,
      museBriefStale: museBriefRaw?.stale ? museBriefRaw : null,
    });
  } catch (err: any) {
    return res.status(500).json({ error: String(err?.message ?? err) });
  }
});

router.post("/desk-commentaries/daily-news/refresh", requireAdmin, aiLimiter, async (req, res) => {
  try {
    await ensureDeskCommentariesTable().catch(() => null);
    lastDeskIngestAt = Date.now();
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
    const force =
      req.body?.force === true
      || req.body?.force === "1"
      || String(req.query.force ?? "") === "1";
    const prior = loadCache(win.dateKey);
    let newSince = 0;
    if (prior?.maxReceivedAt || prior?.generatedAt) {
      const sinceMs = new Date(prior.maxReceivedAt ?? prior.generatedAt).getTime();
      if (Number.isFinite(sinceMs)) {
        newSince = rows.filter((r) => r.receivedAt.getTime() > sinceMs).length;
      }
    } else {
      newSince = rows.length;
    }
    const museBriefEarly = loadMuseBrief(win.dateKey);
    const material = assessMateriality({
      cache: prior,
      rows,
      included,
      newSince,
      museBrief: museBriefEarly,
      book: book.all,
    });
    if (prior && !force && !material.material) {
      return res.json({
        date: win.dateKey,
        sessionStartPt: win.startDatePt,
        sessionLabel: win.label,
        isWeekendPack: win.isWeekendPack,
        todayCount: rows.length,
        includedCount: included.length,
        excludedCount: rows.length - included.length,
        newSinceLastSummary: newSince,
        maxReceivedAt: rows[0]?.receivedAt?.toISOString() ?? null,
        statusLine: material.statusLine,
        editionId: prior.editionId ?? material.editionId,
        materialSuggested: false,
        materialReasons: material.reasons,
        skipped: true,
        message: material.statusLine,
        summary: {
          content: prior.content,
          generatedAt: prior.generatedAt,
          emailCount: prior.emailCount,
          includedCount: prior.includedCount ?? prior.emailCount,
          maxReceivedAt: prior.maxReceivedAt,
          sources: prior.sources,
          categories: prior.categories ?? [],
          sessionStartPt: prior.sessionStartPt,
          digFacts: filterDisplayDigFacts(prior.digFacts ?? []),
          bookHits: prior.bookHits ?? [],
          earningsNear: prior.earningsNear ?? "",
          earningsNearRows: prior.earningsNearRows ?? [],
          marketEarningsRows: prior.marketEarningsRows ?? [],
          modelContracts: prior.modelContracts ?? [],
          editionId: prior.editionId ?? null,
        },
        museBrief: museBriefEarly,
      });
    }
    const earningsPack = await loadNearEarnings(book.all).catch(
      (): { text: string; rows: EarningsNearRow[]; marketRows: EarningsNearRow[] } => ({
        text: "(earnings lookup failed)",
        rows: [],
        marketRows: [],
      }),
    );
    const earningsNear = earningsPack.text;
    const earningsNearRows = earningsPack.rows;
    const marketEarningsRows = earningsPack.marketRows;
    const modelPack = await loadModelContracts(book.all).catch(
      (): { text: string; rows: ModelContractRow[] } => ({ text: "(model lookup failed)", rows: [] }),
    );
    const museBrief = museBriefEarly;

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
    const promptBase = `You APPEND desk-email findings to an existing Muse market brief for a ${DESK_BRIEF_PREFS.role}.
The UI already shows Muse's brief. Your job is NOT to rewrite or paraphrase that brief.

Session: ${win.label} (PT date ${win.dateKey}).

Process (in order):
1) Read MUSE BRIEF below (already published).
2) Read DESK EMAILS + DIG. Keep only facts that are (a) material to a put-seller and (b) NOT already covered by Muse (same event/level/story).
3) If a desk fact updates a Muse level (new print, revised figure), one short "update" bullet is OK.
4) If nothing material is new, write one bullet under Desk adds: **No material desk adds** (Muse brief stands).

WANT:
${DESK_BRIEF_PREFS.want.map((w) => `- ${w}`).join("\n")}

AVOID:
${DESK_BRIEF_PREFS.avoid.map((w) => `- ${w}`).join("\n")}
- Paraphrasing Muse bullets, banner, or title (UI shows them).
- TipRanks "N new analyst rating(s)" without firm/grade/PT.
- Vague "lean into HOOD/NVDA/OPEN" without put|call, strike, expiry, premium from MODEL CONTRACTS.
- Em-dashes (—). Use parentheses for asides, e.g. **Lead** (detail with number).
- Starting the output with "# " or restating "Morning market brief".

MUSE BRIEF (do not rewrite; only ADD beyond this):
${museBrief?.promptExcerpt ?? "(no Muse brief file — then Desk adds may include light macro from emails only)"}

BOOK CONTEXT:
${bookCtx}

NEAR EARNINGS:
${earningsNear}

MODEL CONTRACTS (cite only these for side/strike/expiry/premium):
${modelPack.text}

DIG (firm/grade/PT when present):
${digBlock}

User feedback:
${feedbackBlock}

Rules:
- 3–8 bullets total. Prefer fewer high-signal adds.
- Bullet form: "- **Lead with number** (one clause ≤28 words)."
- Tickers CAPS. Dates YYYY-MM-DD (UI → m/d/yy).
- Sector & tickers: upgrades/downgrades/PTs from DIG/emails that Muse did not cover.
- Put-seller takeaway: one bullet per named ticker using MODEL CONTRACTS:
  **- TICKER: sell put|call $STRIKE exp YYYY-MM-DD @ $PREMIUM** (why). Else "no model contract".
- ${excludedN} emails already noise-filtered.
- Keep under 180 words.

Structure exactly:
## Desk adds
## Sector & tickers
## Put-seller takeaway

=== DESK EMAILS (top ${ranked.length} of ${included.length} included / ${rows.length} total) ===
${pack || "(all emails filtered as noise — say so briefly)"}`;

    let content = (
      await callHaiku({
        prompt: promptBase,
        maxTokens: 560,
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
          maxTokens: 560,
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
          "## Desk adds\n- **No material desk adds** (Muse brief stands; dig lacked firm/grade).\n\n## Sector & tickers\n- **No confirmed rating/PT adds** beyond Muse.\n\n## Put-seller takeaway\n- **No model contract named** (see Model contracts strip).";
      }
    }

    const sources = [...new Set(ranked.map((r) => r.source))];
    const categories = [...new Set(ranked.map((r) => r.category ?? r.kind).filter(Boolean))] as string[];
    const maxReceivedAt = rows[0]?.receivedAt?.toISOString() ?? null;
    const generatedAt = new Date().toISOString();
    const editionId = `${win.dateKey}:${museBrief?.edition ?? "desk"}:${generatedAt}`;
    const cache: DailyNewsCache = {
      date: win.dateKey,
      sessionStartPt: win.startDatePt,
      content,
      generatedAt,
      emailCount: rows.length,
      includedCount: included.length,
      maxReceivedAt,
      sources,
      categories,
      digFacts: filterDisplayDigFacts(allDigFacts).slice(0, 24),
      bookHits,
      earningsNear,
      earningsNearRows,
      marketEarningsRows,
      modelContracts: modelPack.rows,
      editionId,
      museFile: museBrief?.file ?? null,
      museBanner: museBrief?.banner ?? null,
      museContentHash: museBrief?.contentHash ?? null,
      bannerLevels: parseBannerLevels(museBrief?.banner),
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
      statusLine: `Desk adds ${formatPtShort(generatedAt)} · ${included.length} emails`,
      editionId,
      materialSuggested: false,
      materialReasons: force ? ["forced"] : material.reasons,
      skipped: false,
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
        earningsNearRows,
        marketEarningsRows,
        modelContracts: modelPack.rows,
        editionId,
      },
      marketEarningsRows,
      museBrief,
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

/** A143 — OpenJev overnight headline labels (display only; S037: no forecast). */
router.get("/desk-commentaries/daily-news/oj-labels", requireAdmin, async (req, res) => {
  try {
    const ticker = req.query["ticker"] ? String(req.query["ticker"]).toUpperCase() : null;
    const since = new Date(Date.now() - 36 * 3600_000).toISOString();
    const rows = ticker
      ? await db.execute(sql`
          SELECT ticker, ts::text, headline, url, rel, dir, cat
          FROM watchlist_sync.openjev_headline_labels
          WHERE ticker = ${ticker} AND ts >= ${since}::timestamptz AND rel > 0.5
          ORDER BY ABS(dir) DESC, ts DESC LIMIT 40`)
      : await db.execute(sql`
          SELECT ticker, ts::text, headline, url, rel, dir, cat
          FROM watchlist_sync.openjev_headline_labels
          WHERE ts >= ${since}::timestamptz AND rel > 0.5
          ORDER BY
            CASE cat WHEN 'earnings' THEN 0 WHEN 'legal' THEN 1 ELSE 2 END,
            ABS(dir) DESC, ts DESC
          LIMIT 80`);
    const list = (Array.isArray(rows) ? rows : (rows as { rows?: unknown[] }).rows ?? []) as Array<{
      ticker: string; ts: string; headline: string; url: string | null; rel: number; dir: number; cat: string;
    }>;
    return res.json({
      note: "OpenJev label, not a forecast (S037: no next-day edge)",
      count: list.length,
      items: list,
    });
  } catch (err: any) {
    // Table may not exist until first 05:30 desk-headlines run.
    return res.json({ note: "OpenJev labels pending first overnight run", count: 0, items: [], error: String(err?.message ?? err).slice(0, 120) });
  }
});

export default router;
