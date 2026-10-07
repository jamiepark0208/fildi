export interface CatalystAnalystAction {
  firm: string;
  toGrade: string;
  fromGrade: string;
  action: string;
  date: string | null;
}

export interface CatalystNewsItem {
  title: string;
  publishedAt: string | null;
}

export type CatalystLean = "bull" | "bear" | "neutral";

export interface CatalystItem {
  text: string;
  lean: CatalystLean;
  kind: "earnings" | "analyst" | "news";
}

const EVENT_KEYWORDS = /\b(earnings|fda|merger|acquisition|lawsuit|guidance|dividend|split|ipo|bankruptcy|recall|approval|trial|settlement)\b/i;
/** News titles where the keyword alone is enough to lean — everything else stays neutral. */
const NEWS_BEAR = /\b(bankruptcy|recall)\b/i;

const ACTION_LABEL: Record<string, string> = {
  main: "maintains",
  maintain: "maintains",
  hold: "maintains", // FMP sometimes uses action=hold for maintain/reiterate
  reit: "reiterated",
  reiterate: "reiterated",
  up: "upgraded",
  upgrade: "upgraded",
  down: "downgraded",
  downgrade: "downgraded",
  init: "initiated",
  initiate: "initiated",
  initiated: "initiated",
};

const BULL_GRADES = new Set([
  "buy", "strong buy", "overweight", "outperform", "accumulate", "positive",
  "speculative buy", "trading buy", "conviction buy", "top pick",
]);
const BEAR_GRADES = new Set([
  "sell", "strong sell", "underweight", "underperform", "reduce", "negative", "avoid",
]);

/** Normalize Yahoo / FMP action tokens to a small set. */
export function normalizeAnalystAction(action: string): string {
  const a = (action ?? "").toLowerCase().trim();
  if (a === "up" || a === "upgrade" || a === "upgraded") return "upgrade";
  if (a === "down" || a === "downgrade" || a === "downgraded") return "downgrade";
  if (a === "init" || a === "initiate" || a === "initiated") return "initiate";
  if (a === "main" || a === "maintain" || a === "maintained" || a === "hold") return "maintain";
  if (a === "reit" || a === "reiterate" || a === "reiterated") return "reiterate";
  return a;
}

function normalizeGrade(grade: string): string {
  return grade.toLowerCase().replace(/[_-]+/g, " ").replace(/\s+/g, " ").trim();
}

/** Lean from a rating label alone (initiate / maintain). */
export function gradeLean(grade: string): CatalystLean {
  const g = normalizeGrade(grade);
  if (!g) return "neutral";
  if (BULL_GRADES.has(g)) return "bull";
  if (BEAR_GRADES.has(g)) return "bear";
  // Prefix match for "Buy - Long Term" style labels
  for (const b of BULL_GRADES) if (g.startsWith(b + " ") || g.endsWith(" " + b)) return "bull";
  for (const b of BEAR_GRADES) if (g.startsWith(b + " ") || g.endsWith(" " + b)) return "bear";
  return "neutral";
}

/**
 * Directional lean for an analyst event.
 * Upgrade always bull, downgrade always bear (e.g. Buy→Neutral is bearish).
 * Initiate / maintain / reiterate use the destination grade.
 */
export function classifyAnalystLean(action: string, toGrade: string): CatalystLean {
  const act = normalizeAnalystAction(action);
  if (act === "upgrade") return "bull";
  if (act === "downgrade") return "bear";
  if (act === "initiate" || act === "maintain" || act === "reiterate") return gradeLean(toGrade);
  return gradeLean(toGrade);
}

/** Yahoo returns epoch as seconds, ms, ISO string, or Date depending on module/version. */
export function yahooEpochToMs(epoch: unknown): number {
  if (epoch == null) return 0;
  if (epoch instanceof Date) return epoch.getTime();
  if (typeof epoch === "number") return epoch > 1e12 ? epoch : epoch * 1000;
  const parsed = Date.parse(String(epoch));
  return Number.isFinite(parsed) ? parsed : 0;
}

export function yahooEpochToDateStr(epoch: unknown): string | null {
  const ms = yahooEpochToMs(epoch);
  if (!ms) return null;
  return new Date(ms).toISOString().slice(0, 10);
}

/** Parse earnings from Yahoo calendarEvents (+ optional DB fallback). */
export function parseEarningsDate(summary: unknown, dbDate: string | null): string | null {
  if (dbDate) return dbDate.slice(0, 10);
  const dates = (summary as { calendarEvents?: { earnings?: { earningsDate?: unknown } } })
    ?.calendarEvents?.earnings?.earningsDate;
  const d = Array.isArray(dates) ? dates[0] : dates;
  if (d == null) return null;
  if (d instanceof Date) return d.toISOString().slice(0, 10);
  if (typeof d === "number") return new Date(d > 1e12 ? d : d * 1000).toISOString().slice(0, 10);
  if (typeof d === "string" && d.length >= 10) return d.slice(0, 10);
  return null;
}

function daysUntil(iso: string): number {
  const d = new Date(iso.includes("T") ? iso : iso + "T12:00:00").getTime();
  return Math.round((d - Date.now()) / 86400000);
}

function analystLine(a: CatalystAnalystAction): string | null {
  const act = normalizeAnalystAction(a.action ?? "");
  const firm = a.firm || "Analyst";
  const to = a.toGrade || "";
  const from = a.fromGrade || "";
  const date = a.date ?? "";
  const dateSuffix = date ? ` (${date})` : "";

  if (act === "upgrade") {
    return from && from !== to
      ? `${firm} upgraded from ${from} to ${to}${dateSuffix}`
      : `${firm} upgraded to ${to}${dateSuffix}`;
  }
  if (act === "downgrade") {
    // "cut" reads clearer than "downgraded" for Buy→Neutral etc.
    return from && from !== to
      ? `${firm} cut from ${from} to ${to}${dateSuffix}`
      : `${firm} cut to ${to}${dateSuffix}`;
  }
  if (act === "initiate") {
    return to ? `${firm} rated ${to}${dateSuffix}` : null;
  }
  if (to) {
    const label = ACTION_LABEL[act] ?? act;
    return `${firm} ${label || "maintains"} ${to}${dateSuffix}`;
  }
  return null;
}

function newsLean(title: string): CatalystLean {
  if (NEWS_BEAR.test(title)) return "bear";
  return "neutral";
}

/** Structured catalysts with deterministic lean (analyst up/down/init-by-grade; narrow news). */
export function buildCatalystItems(input: {
  earningsDate: string | null;
  analystActions: CatalystAnalystAction[];
  news: CatalystNewsItem[];
}): CatalystItem[] {
  const out: CatalystItem[] = [];
  const cutoff90 = Date.now() - 90 * 86400000;

  if (input.earningsDate) {
    const days = daysUntil(input.earningsDate);
    if (days >= 0 && days <= 30) {
      out.push({
        kind: "earnings",
        lean: "neutral",
        text: days <= 14
          ? `Earnings in ${days} days (${input.earningsDate})`
          : `Earnings on ${input.earningsDate}`,
      });
    } else if (days > 30) {
      out.push({ kind: "earnings", lean: "neutral", text: `Next earnings ${input.earningsDate}` });
    }
  }

  const EVENT_ACTIONS = new Set(["upgrade", "downgrade", "initiate"]);
  const analystItems = input.analystActions
    .filter(a => {
      if (!EVENT_ACTIONS.has(normalizeAnalystAction(a.action ?? ""))) return false;
      if (!a.date) return true;
      return new Date(a.date + "T12:00:00").getTime() >= cutoff90;
    })
    .map((a): CatalystItem | null => {
      const text = analystLine(a);
      if (!text) return null;
      return {
        kind: "analyst" as const,
        lean: classifyAnalystLean(a.action, a.toGrade),
        text,
      };
    })
    .filter((x): x is CatalystItem => !!x)
    .slice(0, 3);
  out.push(...analystItems);

  const newsItems = input.news
    .filter(n => n.title && EVENT_KEYWORDS.test(n.title))
    .slice(0, 2)
    .map(n => ({
      kind: "news" as const,
      lean: newsLean(n.title),
      text: n.title.trim(),
    }));
  out.push(...newsItems);

  return out.slice(0, 6);
}

/** Plain-string form (neutral + lean lines) — kept for callers/tests that only need text. */
export function buildCatalysts(input: {
  earningsDate: string | null;
  analystActions: CatalystAnalystAction[];
  news: CatalystNewsItem[];
}): string[] {
  return buildCatalystItems(input).map(i => i.text);
}

/** Firm key for deduping catalyst vs event-bullet analyst lines. */
export function analystFirmKey(line: string): string | null {
  const m = line.match(/^(.+?)\s+(upgraded|cut|rated|downgraded|initiated|maintains|reiterated)\b/i);
  return m ? m[1]!.toLowerCase().replace(/\s+/g, " ").trim() : null;
}

export function mergeCaseBullets(leanLines: string[], existing: string[], cap = 6): string[] {
  const out: string[] = [];
  const seenFirms = new Set<string>();
  for (const line of leanLines) {
    out.push(line);
    const fk = analystFirmKey(line);
    if (fk) seenFirms.add(fk);
  }
  for (const line of existing) {
    const fk = analystFirmKey(line);
    if (fk && seenFirms.has(fk)) continue;
    if (out.includes(line)) continue;
    out.push(line);
  }
  return out.slice(0, cap);
}
