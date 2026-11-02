/**
 * Secondary dig for desk emails: parse analyst/PT facts from body + content links.
 * TipRanks watchlist digests often bury the signal in the body; tracking hosts
 * (pstmrk) must be unwrapped before any fetch.
 *
 * Shallow TipRanks teasers ("1 new analyst rating(s)") are NOT actionable —
 * callers must enrich via Yahoo/DB (see desk-dig-enrich.ts) before prompting.
 */
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { sql } from "drizzle-orm";
import { db } from "@workspace/db";
import { unwrapRedirectUrl } from "./desk-commentary-normalize.js";
import { parseAnalystClaim } from "./desk-fact-resolve.js";
import { logger } from "./logger.js";

export type DigKind =
  | "analyst_rating"
  | "price_target"
  | "upgrade"
  | "downgrade"
  | "earnings"
  | "other";

export interface DigFact {
  ticker: string;
  kind: DigKind;
  detail: string;
  source: string;
  url?: string;
}

const SHALLOW_RATING_RE = /^\d+\s+new analyst rating/i;

/** Common English / prose tokens the upgrade|PT regexes mis-capture ("upgraded to Buy"). */
const DIG_TICKER_STOPWORDS = new Set([
  "TO", "GOT", "FOR", "THE", "AND", "NEW", "ALL", "ARE", "WAS", "HAS", "HAD",
  "NOT", "BUT", "YOU", "CAN", "MAY", "OUR", "OUT", "ANY", "ITS", "HIS", "HER",
  "WHO", "HOW", "WHY", "VIA", "PER", "CEO", "CFO", "IPO", "ETF", "USA", "USD",
]);

export function isPlausibleDigTicker(ticker: string): boolean {
  const t = ticker.toUpperCase();
  return /^[A-Z]{1,5}$/.test(t) && !DIG_TICKER_STOPWORDS.has(t);
}

/** TipRanks digest teasers with no firm/grade/PT — worthless as catalysts alone. */
export function isShallowDigFact(f: DigFact): boolean {
  return f.kind === "analyst_rating" && SHALLOW_RATING_RE.test(f.detail.trim());
}

/** UI + prompt: drop shallow teasers and prose false-positive tickers. */
export function filterDisplayDigFacts(facts: DigFact[]): DigFact[] {
  return facts.filter((f) => isPlausibleDigTicker(f.ticker) && !isShallowDigFact(f));
}

/** Prefer firm/grade/PT facts over TipRanks count teasers for the same ticker. */
export function mergePreferRichDigFacts(...batches: DigFact[][]): DigFact[] {
  const flat = batches.flat();
  const richTickers = new Set(flat.filter((f) => !isShallowDigFact(f)).map((f) => f.ticker));
  const seen = new Set<string>();
  const out: DigFact[] = [];
  for (const f of flat) {
    if (isShallowDigFact(f) && richTickers.has(f.ticker)) continue;
    const k = `${f.ticker}|${f.kind}|${f.detail}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(f);
  }
  return out.slice(0, 40);
}

/** Postmark / TipRanks click wrappers: …/3s/www.tipranks.com*2Fstocks*2FOKLO*3F… */
export function unwrapPstmrkUrl(raw: string): string {
  let url = unwrapRedirectUrl(raw);
  const m = url.match(/pstmrk\.it\/3s\/(.+?)(?:\/enfm\/|$)/i);
  if (!m?.[1]) return url;
  const decoded = m[1]
    .replace(/\*/g, "%")
    .replace(/%2F/gi, "/")
    .replace(/%3F/gi, "?")
    .replace(/%3D/gi, "=")
    .replace(/%26/gi, "&");
  try {
    const full = decoded.startsWith("http") ? decoded : `https://${decoded}`;
    return unwrapRedirectUrl(full.split("/enfm/")[0] ?? full);
  } catch {
    return url;
  }
}

export function extractDigFactsFromText(text: string, source = "body"): DigFact[] {
  const facts: DigFact[] = [];
  const seen = new Set<string>();
  const push = (f: DigFact) => {
    if (!isPlausibleDigTicker(f.ticker)) return;
    const k = `${f.ticker}|${f.kind}|${f.detail.slice(0, 80)}`;
    if (seen.has(k)) return;
    seen.add(k);
    facts.push(f);
  };

  // TipRanks watchlist style: "Oklo Inc (OKLO)" then "1 new analyst ratings published"
  // (URLs / blank lines may sit between ticker and rating — look ahead further.)
  const lines = text.split(/\n+/);
  for (let i = 0; i < lines.length; i++) {
    const nameHit = lines[i]!.match(/\(([A-Z]{1,5})\)\s*$/);
    if (!nameHit) continue;
    const ticker = nameHit[1]!;
    const window = lines.slice(i, i + 8).join(" ");
    if (/new analyst ratings? published/i.test(window)) {
      const n = window.match(/(\d+)\s+new analyst ratings?/i)?.[1] ?? "1";
      push({ ticker, kind: "analyst_rating", detail: `${n} new analyst rating(s)`, source });
    } else if (/price target/i.test(window)) {
      const pt = window.match(/price targets?\s*(?:to|of|at|:)?\s*\$?\s*([\d,.]+)/i)?.[1];
      push({
        ticker,
        kind: "price_target",
        detail: pt ? `PT $${pt}` : "price target update",
        source,
      });
    } else if (/upgrad/i.test(window)) {
      push({ ticker, kind: "upgrade", detail: window.replace(/\s+/g, " ").trim().slice(0, 120), source });
    } else if (/downgrad/i.test(window)) {
      push({ ticker, kind: "downgrade", detail: window.replace(/\s+/g, " ").trim().slice(0, 120), source });
    }
  }

  // Inline: "NVDA PT to $240" / "NVDA price target raised to $180"
  for (const m of text.matchAll(
    /\b([A-Z]{1,5})\b[^.\n]{0,60}?(?:price target|PT)\b[^$\n]{0,40}?\$\s*([\d,.]+)/gi,
  )) {
    push({
      ticker: m[1]!.toUpperCase(),
      kind: "price_target",
      detail: `PT $${m[2]}`,
      source,
    });
  }

  // "upgraded NVDA to Buy" / "downgraded TSLA to Hold"
  for (const m of text.matchAll(
    /\b(upgraded|downgraded)\s+([A-Z]{1,5})\b[^.\n]{0,40}?(?:to\s+)?(Strong Buy|Buy|Hold|Sell|Overweight|Underweight|Neutral|Outperform|Underperform)?/gi,
  )) {
    const kind: DigKind = /^up/i.test(m[1]!) ? "upgrade" : "downgrade";
    push({
      ticker: m[2]!.toUpperCase(),
      kind,
      detail: [m[1], m[3]].filter(Boolean).join(" ").trim(),
      source,
    });
  }

  return facts.slice(0, 24);
}

function stripHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}

/** Per Regen crawl budget (A301) — shared across digDeskItem calls. */
let crawlBudgetLeft = 0;

export function resetDeskCrawlBudget(n = 4): void {
  crawlBudgetLeft = Math.max(0, n);
}

export function deskCrawlBudgetLeft(): number {
  return crawlBudgetLeft;
}

async function fetchText(url: string, timeoutMs = 8_000): Promise<string | null> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      redirect: "follow",
      headers: {
        "User-Agent": "TradeDashDeskDig/1.0 (+local research; contact: desk)",
        Accept: "text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.8",
      },
    });
    if (!res.ok) return null;
    const ct = res.headers.get("content-type") ?? "";
    if (!/html|text|json/i.test(ct) && ct) return null;
    const raw = await res.text();
    // Cloudflare interstitial
    if (/Just a moment|Enable JavaScript and cookies/i.test(raw) && raw.length < 4_000) return null;
    return stripHtml(raw).slice(0, 12_000);
  } catch (err) {
    logger.debug({ err, url }, "desk-link-dig: fetch failed");
    return null;
  } finally {
    clearTimeout(t);
  }
}

/** Crawl4AI via scripts/fetch-page.sh — only when plain fetch empty/JS-walled (A301). */
async function fetchTextViaCrawl(url: string): Promise<string | null> {
  if (crawlBudgetLeft <= 0) return null;
  crawlBudgetLeft -= 1;
  try {
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const execFileAsync = promisify(execFile);
    const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");
    const script = join(root, "scripts", "fetch-page.sh");
    const { stdout } = await execFileAsync(script, [url, "--max-chars", "8000"], {
      timeout: 45_000,
      maxBuffer: 2 * 1024 * 1024,
      env: process.env,
    });
    const text = (stdout ?? "").trim();
    return text.length >= 80 ? text.slice(0, 12_000) : null;
  } catch (err) {
    logger.debug({ err, url }, "desk-link-dig: crawl fetch failed");
    return null;
  }
}

/** Dig content links (max few) for PT/rating facts when body is thin. */
export async function digContentLinks(
  links: Array<{ url: string }>,
  opts?: { maxLinks?: number; sourceHint?: string; allowCrawl?: boolean },
): Promise<DigFact[]> {
  const maxLinks = opts?.maxLinks ?? 3;
  const facts: DigFact[] = [];
  const candidates = links
    .map((l) => unwrapPstmrkUrl(l.url))
    .filter((u) => /tipranks\.com\/(news|stocks)|seekingalpha\.com|finimize\.com/i.test(u))
    .filter((u) => !/unsubscribe|personal-settings|best-online-brokers|calendars\/economic/i.test(u))
    .slice(0, maxLinks);

  for (const url of candidates) {
    let text = await fetchText(url);
    if ((!text || text.length < 80) && opts?.allowCrawl) {
      text = await fetchTextViaCrawl(url);
    }
    if (!text || text.length < 80) continue;
    const dug = extractDigFactsFromText(text, opts?.sourceHint ?? "link");
    for (const f of dug) facts.push({ ...f, url });
  }
  return facts.slice(0, 16);
}

const TEASER_RE = /(\d+)\s+new analyst ratings? published/i;

/**
 * E6 (briefs dig D2): Live reads the one extractor's facts (desk_facts) instead of re-parsing bodies.
 * Per commentary id: DigFacts from analyst_action + earnings_detail facts, or absent when the email has no ok/empty run yet
 * (caller falls back to the body regex). TipRanks teasers keep the shallow form so the Yahoo enrich step still runs.
 */
export async function deskFactsAsDig(ids: number[]): Promise<Map<number, DigFact[]>> {
  const out = new Map<number, DigFact[]>();
  if (!ids.length) return out;
  const arr = sql.raw(`ARRAY[${ids.map(Number).join(",")}]::int[]`);
  const runs = await db.execute(sql`SELECT commentary_id FROM desk_fact_runs WHERE status IN ('ok', 'empty') AND commentary_id = ANY(${arr})`)
    .catch(() => ({ rows: [] as unknown[] }));
  for (const r of runs.rows as { commentary_id: number }[]) out.set(Number(r.commentary_id), []);
  if (!out.size) return out;
  const facts = await db.execute(sql`SELECT f.commentary_id, f.kind, f.tickers, f.claim, c.source FROM desk_facts f
    JOIN desk_commentaries c ON c.id = f.commentary_id
    WHERE f.commentary_id = ANY(${arr}) AND f.kind IN ('analyst_action', 'earnings_detail') AND jsonb_array_length(f.tickers) > 0
    ORDER BY f.id`).catch(() => ({ rows: [] as unknown[] }));
  for (const f of facts.rows as { commentary_id: number; kind: string; tickers: string[]; claim: string; source: string }[]) {
    const list = out.get(Number(f.commentary_id));
    if (!list) continue;
    const teaser = TEASER_RE.exec(f.claim);
    const a = f.kind === "analyst_action" ? parseAnalystClaim(f.claim).action : null;
    const kind: DigKind = f.kind === "earnings_detail" ? "earnings" : teaser ? "analyst_rating"
      : a === "up" ? "upgrade" : a === "down" ? "downgrade" : a === "pt" || parseAnalystClaim(f.claim).pt != null ? "price_target" : "analyst_rating";
    const detail = teaser ? `${teaser[1]} new analyst rating(s)` : f.claim.slice(0, 160);
    for (const ticker of f.tickers) if (isPlausibleDigTicker(ticker)) list.push({ ticker, kind, detail, source: f.source });
  }
  return out;
}

export interface DeskDigInput {
  source: string;
  subject: string;
  bodyPlain: string | null;
  synopsis: string | null;
  contentLinks?: Array<{ url: string }>;
}

/**
 * Body-first dig; fetch links when body is thin OR only yields shallow
 * TipRanks count teasers (pages often 403 — enrich step covers the rest).
 * `allowCrawl`: spend Regen crawl budget only for book/theme hits (A301).
 */
export async function digDeskItem(
  row: DeskDigInput,
  opts?: { allowCrawl?: boolean; facts?: DigFact[] },
): Promise<DigFact[]> {
  const text = `${row.subject}\n${row.synopsis ?? ""}\n${row.bodyPlain ?? ""}`;
  let facts = opts?.facts ?? extractDigFactsFromText(text, row.source);
  const allShallow = facts.length > 0 && facts.every(isShallowDigFact);
  const needsFetch =
    (facts.length < 2 || allShallow) &&
    /watchlist|new activity|analyst|price target|rating|continue reading/i.test(
      `${row.subject} ${row.synopsis ?? ""}`,
    );
  if (needsFetch && row.contentLinks?.length) {
    const dug = await digContentLinks(row.contentLinks, {
      maxLinks: 3,
      sourceHint: row.source,
      allowCrawl: !!opts?.allowCrawl && facts.every(isShallowDigFact),
    });
    facts = mergePreferRichDigFacts(facts, dug);
  }
  const seen = new Set<string>();
  return facts
    .filter((f) => {
      const k = `${f.ticker}|${f.kind}|${f.detail}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    })
    .slice(0, 20);
}

/**
 * Prompt DIG block — omit shallow teasers. If only shallow remain, say so
 * explicitly so Haiku does not invent firm/grade.
 */
export function formatDigFactsForPrompt(facts: DigFact[]): string {
  const rich = facts.filter((f) => !isShallowDigFact(f));
  const shallow = facts.filter(isShallowDigFact);
  if (!rich.length && !shallow.length) return "(none extracted)";
  const lines = rich.map(
    (f) => `- ${f.ticker}: ${f.kind.replace(/_/g, " ")} — ${f.detail} [${f.source}]`,
  );
  if (shallow.length) {
    const tickers = [...new Set(shallow.map((f) => f.ticker))].join(", ");
    lines.push(
      `- INCOMPLETE (do NOT cite as catalyst): TipRanks flagged activity on ${tickers} but firm/grade/PT was not confirmed — omit these names unless another email has detail.`,
    );
  }
  return lines.join("\n");
}
