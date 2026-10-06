/**
 * Deterministic desk-email normalize (pre-Haiku).
 * Pure functions — fixture-tested. Never calls LLM / network.
 */
import type { DeskKind } from "./desk-commentary-parse.js";

export type DeskCategory =
  | "overnight"
  | "market_recap"
  | "macro"
  | "politics"
  | "sector"
  | "earnings"
  | "newsletter_digest"
  | "research_note"
  | "promo"
  | "other";

export type LinkKindHint = "unsubscribe" | "tracking" | "social" | "promo" | "content" | "unknown";

export interface OutboundLink {
  url: string;
  text?: string;
  host?: string;
  kindHint?: LinkKindHint;
}

export interface NormalizedDesk {
  sourceId: string;
  category: DeskCategory;
  kind: DeskKind | string;
  fromAddress: string | null;
  fromDomain: string | null;
  articlePublishedAt: Date | null;
  noiseScore: number;
  noiseReasons: string[];
  synopsis: string;
  tickersMentioned: string[];
  contentLinks: OutboundLink[];
  outboundLinks: OutboundLink[];
  parserVersion: number;
  includeInBrief: boolean;
}

const TICKER_STOP = new Set([
  "US", "SA", "AM", "PM", "ET", "EST", "EDT", "PT", "PST", "PDT", "UTC",
  "CEO", "CFO", "COO", "IPO", "ETF", "GDP", "CPI", "PPI", "FED", "FOMC",
  "FDA", "SEC", "AI", "EV", "UK", "EU", "NY", "DC", "Q1", "Q2", "Q3", "Q4",
  "YOY", "QOQ", "MOM", "ATM", "OTM", "ITM", "DTE", "IV", "PE", "EPS",
  "EWT", "HTTP", "HTTPS", "WWW", "PDF", "HTML",
]);

/** Domain / slug → canonical sourceId */
const SOURCE_REGISTRY: Array<{ match: RegExp; sourceId: string; defaultCategory: DeskCategory }> = [
  { match: /factset|streetaccount/i, sourceId: "factset_streetaccount", defaultCategory: "overnight" },
  { match: /seekingalpha/i, sourceId: "seekingalpha", defaultCategory: "research_note" },
  { match: /bloomberg/i, sourceId: "bloomberg", defaultCategory: "newsletter_digest" },
  { match: /axios/i, sourceId: "axios", defaultCategory: "newsletter_digest" },
  { match: /zerohedge/i, sourceId: "zerohedge", defaultCategory: "macro" },
  { match: /tipranks/i, sourceId: "tipranks", defaultCategory: "research_note" },
  { match: /finimize/i, sourceId: "finimize", defaultCategory: "research_note" },
  { match: /thedailyupside|dailyupside/i, sourceId: "thedailyupside", defaultCategory: "newsletter_digest" },
  { match: /beehiiv/i, sourceId: "beehiiv", defaultCategory: "newsletter_digest" },
  { match: /lseg|refinitiv/i, sourceId: "lseg", defaultCategory: "macro" },
];

const FACTSET_KIND_TO_CATEGORY: Record<string, DeskCategory> = {
  us_overnight: "overnight",
  us_market_recap: "market_recap",
  politics: "politics",
  sector_consumer: "sector",
  sector_energy: "sector",
  sector_technology: "sector",
  macro_oil: "macro",
  us_monthly_recap: "market_recap",
  us_quarterly_recap: "market_recap",
  us_week_ahead: "macro",
  morning_watchlist: "newsletter_digest",
  promo: "promo",
};

/** Trader prefs baked into brief packing (Haiku reads these as constraints). */
export const DESK_BRIEF_PREFS = {
  role: "cash-secured put / covered-call seller",
  want: [
    "macro regime (rates, payrolls, Fed, liquidity)",
    "cross-asset stress (oil, credit, VIX, USD/JPY yields)",
    "geopolitics with market path",
    "sector catalysts that move large liquid names",
    "weekend / week-ahead calendar risk",
  ],
  avoid: [
    "subscription / welcome / you've subscribed confirmations",
    "single-name pitch letters with no macro context",
    "promo CTAs, affiliate softbank-style ads",
    "unsubscribe / preference / social chrome",
    "Proofpoint / urldefense wrapper noise",
  ],
  noiseExcludeAtOrAbove: 70,
};

export function unwrapRedirectUrl(raw: string): string {
  let url = raw.trim().replace(/[.,;:]+$/, "");
  // Proofpoint urldefense v3: .../v3/__https://real__;!!token$
  const ud = url.match(/urldefense\.com\/v3\/__([^;_]+(?:\/\/[^;]+?)?)__/i);
  if (ud?.[1]) {
    try {
      url = decodeURIComponent(ud[1].replace(/\\\//g, "/"));
    } catch {
      url = ud[1];
    }
  }
  // TipRanks / Postmark click wrappers: …/3s/www.tipranks.com*2Fstocks*2FOKLO*3F…
  const pst = url.match(/pstmrk\.it\/3s\/(.+?)(?:\/enfm\/|$)/i);
  if (pst?.[1]) {
    const decoded = pst[1]
      .replace(/\*/g, "%")
      .replace(/%2F/gi, "/")
      .replace(/%3F/gi, "?")
      .replace(/%3D/gi, "=")
      .replace(/%26/gi, "&");
    url = decoded.startsWith("http") ? decoded : `https://${decoded}`;
  }
  // Axios / Finimize click trackers with base64 path segment
  const b64 = url.match(/\/(?:click|c)\/[^/]+\/([A-Za-z0-9+/=_-]{20,})/i);
  if (b64?.[1]) {
    try {
      const pad = b64[1].replace(/-/g, "+").replace(/_/g, "/");
      const decoded = Buffer.from(pad, "base64").toString("utf8");
      if (/^https?:\/\//i.test(decoded)) url = decoded.split(/[?\s]/)[0] ?? decoded;
    } catch { /* keep */ }
  }
  // Strip UTM
  try {
    const u = new URL(url);
    for (const k of [...u.searchParams.keys()]) {
      if (/^utm_/i.test(k) || k === "hash" || k === "l_s" || k === "i_e") u.searchParams.delete(k);
    }
    url = u.toString();
  } catch { /* keep */ }
  return url;
}

export function classifyLink(url: string, host?: string): LinkKindHint {
  const u = url.toLowerCase();
  const h = (host ?? "").toLowerCase();
  if (/unsubscribe|pref(?:erence)?s?|email-settings|manage.?subscription|opt.?out/i.test(u)) return "unsubscribe";
  if (/phishalarm|proofpoint\.com\/ewt|safelinks\.protection/i.test(u)) return "tracking";
  // Unwrapped TipRanks stock/news pages are content; raw pstmrk account links are tracking.
  if (/pstmrk\.it/i.test(h) && !/tipranks\.com\/(stocks|news)/i.test(u)) return "tracking";
  if (/urldefense\.com|click\d*\.email\.|link\.(axios|finimize)/i.test(h) && !/axios\.com\/|finimize\.com\//i.test(u)) {
    return "tracking";
  }
  if (/twitter\.com|x\.com|facebook\.com|linkedin\.com|instagram\.com|youtube\.com/i.test(h)) return "social";
  if (/account\/newsletters|\/subscribe|welcome|personal-settings|my-notifications/i.test(u)) return "promo";
  return "content";
}

export function resolveSourceId(input: {
  source?: string | null;
  from?: string | null;
  fromDomain?: string | null;
  subject?: string | null;
}): { sourceId: string; defaultCategory: DeskCategory } {
  const blob = [input.source, input.from, input.fromDomain, input.subject].filter(Boolean).join(" ");
  for (const row of SOURCE_REGISTRY) {
    if (row.match.test(blob)) return { sourceId: row.sourceId, defaultCategory: row.defaultCategory };
  }
  const domain = (input.fromDomain || "").toLowerCase().replace(/^www\./, "");
  if (domain) return { sourceId: `newsletter:${domain}`, defaultCategory: "newsletter_digest" };
  const slug = (input.source || "desk").toLowerCase();
  return { sourceId: slug === "factset" ? "factset_streetaccount" : slug, defaultCategory: "other" };
}

export function classifyCategory(input: {
  subject: string;
  sourceId: string;
  kind?: string | null;
  defaultCategory: DeskCategory;
}): DeskCategory {
  const s = input.subject.toLowerCase();
  if (/subscribed|welcome to|congratulations on your subscription/i.test(s)) return "promo";
  if (input.kind && FACTSET_KIND_TO_CATEGORY[input.kind]) return FACTSET_KIND_TO_CATEGORY[input.kind]!;
  if (/overnight/i.test(s)) return "overnight";
  if (/market recap|weekly recap/i.test(s)) return "market_recap";
  if (/week ahead|weekend head/i.test(s)) return "macro";
  if (/payroll|fed |fomc|rates? |treasury|bond|yield|oil|liquidity|macro/i.test(s)) return "macro";
  if (/politic|white house|congress|election|trump/i.test(s)) return "politics";
  if (/sector|technology|energy|consumer/i.test(s)) return "sector";
  if (/earnings|eps |guidance/i.test(s)) return "earnings";
  if (input.sourceId === "seekingalpha" || input.sourceId === "tipranks" || input.sourceId === "finimize") {
    return "research_note";
  }
  return input.defaultCategory;
}

export function extractArticlePublishedAt(text: string, receivedAt: Date): Date | null {
  const patterns = [
    /\b(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\s+\d{1,2},\s+\d{4}\b/i,
    /\b\d{4}-\d{2}-\d{2}\b/,
    /\b(?:Sunday|Monday|Tuesday|Wednesday|Thursday|Friday|Saturday),?\s+(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\s+\d{1,2},\s+\d{4}\b/i,
  ];
  for (const re of patterns) {
    const m = text.match(re);
    if (!m) continue;
    const d = new Date(m[0]!);
    if (!Number.isNaN(d.getTime())) {
      // Reject far-future / ancient vs received
      const delta = Math.abs(d.getTime() - receivedAt.getTime());
      if (delta < 14 * 24 * 60 * 60 * 1000) return d;
    }
  }
  return null;
}

export function extractTickersClean(text: string): string[] {
  const out = new Set<string>();
  // "Oklo Inc (OKLO)" / "Tesla (TSLA)"
  for (const m of text.matchAll(/\(([A-Z]{1,5})\)/g)) {
    const t = m[1]!;
    if (!TICKER_STOP.has(t)) out.add(t);
  }
  const re = /\b([A-Z]{1,5})(?:\s*\(|\s+--|\/)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const t = m[1]!;
    if (!TICKER_STOP.has(t)) out.add(t);
  }
  return [...out].slice(0, 40);
}

export function cleanBodyNoise(plain: string): string {
  return plain
    .replace(/ZjQcmQRYFpfptBannerStart[\s\S]*?ZjQcmQRYFpfptBannerEnd/gi, " ")
    .replace(/External Sender[\s\S]{0,500}?Report Suspicious[^\n]*/gi, " ")
    .replace(/\u200c|\u00a0/g, " ")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

export function scoreNoise(input: {
  subject: string;
  body: string;
  category: DeskCategory;
  links: OutboundLink[];
  sourceId: string;
}): { score: number; reasons: string[] } {
  let score = 0;
  const reasons: string[] = [];
  const s = input.subject.toLowerCase();
  const b = input.body.toLowerCase();

  if (/subscribed|welcome to|congratulations on your subscription/i.test(s)) {
    score += 80; reasons.push("welcome_subject");
  }
  if (/thank you for subscribing/i.test(b)) {
    score += 50; reasons.push("subscribe_thanks");
  }
  if (input.category === "promo") {
    score += 40; reasons.push("category_promo");
  }
  if (/softbank|ridiculously undervalued|cherry-?pick|not cherry/i.test(s + " " + b.slice(0, 400))) {
    score += 25; reasons.push("promo_pitch");
  }
  const content = input.links.filter((l) => (l.kindHint ?? classifyLink(l.url, l.host)) === "content");
  const junk = input.links.filter((l) => {
    const k = l.kindHint ?? classifyLink(l.url, l.host);
    return k === "tracking" || k === "unsubscribe" || k === "promo";
  });
  if (input.links.length > 8 && content.length <= 1) {
    score += 20; reasons.push("link_junk_heavy");
  }
  if (junk.length >= 6 && content.length <= 2) {
    score += 15; reasons.push("tracking_dense");
  }
  if (input.body.replace(/\s+/g, " ").trim().length < 120) {
    score += 15; reasons.push("thin_body");
  }
  // TipRanks watchlist digests carry analyst/PT activity — keep (do NOT noise-boost).

  return { score: Math.min(100, score), reasons };
}

function linksFromBody(plain: string, html?: string | null, existing?: OutboundLink[]): OutboundLink[] {
  const out: OutboundLink[] = [];
  const seen = new Set<string>();
  const push = (raw: string, text = "", kindHint?: LinkKindHint) => {
    const unwrapped = unwrapRedirectUrl(raw);
    if (seen.has(unwrapped)) return;
    seen.add(unwrapped);
    let host = "";
    try { host = new URL(unwrapped).host.toLowerCase(); } catch { /* */ }
    out.push({
      url: unwrapped,
      text,
      host,
      kindHint: kindHint ?? classifyLink(unwrapped, host),
    });
  };
  for (const l of existing ?? []) {
    if (l?.url) push(l.url, l.text ?? "", l.kindHint);
  }
  const blob = `${html ?? ""}\n${plain}`;
  const re = /https?:\/\/[^\s"'<>)\]]+/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(blob)) !== null && out.length < 50) {
    push(m[0]!);
  }
  return out;
}

export function normalizeDeskPayload(raw: {
  source?: string | null;
  kind?: string | null;
  subject?: string | null;
  from?: string | null;
  fromDomain?: string | null;
  receivedAt?: string | Date | null;
  synopsis?: string | null;
  bodyPlain?: string | null;
  bodyHtml?: string | null;
  tickersMentioned?: unknown;
  outboundLinks?: OutboundLink[] | null;
  parserVersion?: number | null;
}): NormalizedDesk {
  const subject = String(raw.subject ?? "");
  const receivedAt = raw.receivedAt ? new Date(raw.receivedAt) : new Date();
  const bodyClean = cleanBodyNoise(String(raw.bodyPlain ?? ""));
  const { sourceId, defaultCategory } = resolveSourceId({
    source: raw.source,
    from: raw.from,
    fromDomain: raw.fromDomain,
    subject,
  });
  const category = classifyCategory({
    subject,
    sourceId,
    kind: raw.kind,
    defaultCategory,
  });
  const outboundLinks = linksFromBody(bodyClean, raw.bodyHtml, raw.outboundLinks ?? undefined);
  const contentLinks = outboundLinks
    .filter((l) => l.kindHint === "content")
    .filter((l) => !/unsubscribe|preference/i.test(l.url))
    .slice(0, 5);

  const noise = scoreNoise({
    subject,
    body: bodyClean,
    category,
    links: outboundLinks,
    sourceId,
  });

  // Always merge body extract — Apps Script / trackers often inject junk tickers (IAQ/AQ).
  const fromBody = extractTickersClean(`${bodyClean} ${subject}`);
  const fromRaw = Array.isArray(raw.tickersMentioned)
    ? (raw.tickersMentioned as string[])
        .map((t) => String(t).toUpperCase())
        .filter((t) => /^[A-Z]{1,5}$/.test(t) && !TICKER_STOP.has(t))
    : [];
  const tickers = [...new Set([...fromBody, ...fromRaw])].slice(0, 40);

  let synopsis = String(raw.synopsis ?? "").trim();
  if (!synopsis || /urldefense|phishalarm|external sender/i.test(synopsis.slice(0, 80))) {
    synopsis = bodyClean.replace(/\s+/g, " ").trim().slice(0, 400) || subject.slice(0, 200);
  } else {
    synopsis = cleanBodyNoise(synopsis).replace(/\s+/g, " ").trim().slice(0, 600);
  }

  const articlePublishedAt = extractArticlePublishedAt(
    `${subject}\n${synopsis}\n${bodyClean.slice(0, 800)}`,
    Number.isNaN(receivedAt.getTime()) ? new Date() : receivedAt,
  );

  const fromDomain = raw.fromDomain
    ?? (raw.from?.match(/@([a-z0-9.-]+\.[a-z]{2,})/i)?.[1]?.toLowerCase() ?? null);

  return {
    sourceId,
    category,
    kind: (raw.kind && String(raw.kind)) || category,
    fromAddress: raw.from ?? null,
    fromDomain,
    articlePublishedAt,
    noiseScore: noise.score,
    noiseReasons: noise.reasons,
    synopsis,
    tickersMentioned: tickers,
    contentLinks,
    outboundLinks,
    parserVersion: raw.parserVersion ?? 2,
    includeInBrief: noise.score < DESK_BRIEF_PREFS.noiseExcludeAtOrAbove && category !== "promo",
  };
}

/**
 * America/Los_Angeles news session.
 * Weekdays: calendar day PT. Sat/Sun + Mon before 07:00 PT: from Friday PT (weekend pack).
 * Returns `startDatePt` for SQL: `(startDatePt::date AT TIME ZONE 'America/Los_Angeles')`.
 */
export function newsSessionWindow(now = new Date()): {
  startDatePt: string;
  label: string;
  dateKey: string;
  isWeekendPack: boolean;
} {
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Los_Angeles",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    weekday: "short",
    hour: "2-digit",
    hourCycle: "h23",
  });
  const parts = Object.fromEntries(fmt.formatToParts(now).map((p) => [p.type, p.value]));
  const dateKey = `${parts.year}-${parts.month}-${parts.day}`;
  const wd = String(parts.weekday); // Sun, Mon, …
  const hour = Number(parts.hour);
  const isWeekend = wd === "Sat" || wd === "Sun";
  const earlyMonday = wd === "Mon" && hour < 7;

  if (isWeekend || earlyMonday) {
    const back = earlyMonday ? 3 : wd === "Sun" ? 2 : 1;
    const anchor = new Date(`${dateKey}T16:00:00.000Z`); // midday-ish UTC → stable PT calendar walk
    anchor.setUTCDate(anchor.getUTCDate() - back);
    const startDatePt = anchor.toLocaleDateString("en-CA", { timeZone: "America/Los_Angeles" });
    return {
      startDatePt,
      label: `weekend session (Fri ${startDatePt} → now)`,
      dateKey,
      isWeekendPack: true,
    };
  }

  return {
    startDatePt: dateKey,
    label: `session ${dateKey}`,
    dateKey,
    isWeekendPack: false,
  };
}
