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

const EVENT_KEYWORDS = /\b(earnings|fda|merger|acquisition|lawsuit|guidance|dividend|split|ipo|bankruptcy|recall|approval|trial|settlement)\b/i;

const ACTION_LABEL: Record<string, string> = {
  main: "maintains",
  reit: "reiterated",
  up: "upgraded",
  down: "downgraded",
  init: "initiated",
};

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
  const act = (a.action ?? "").toLowerCase();
  const firm = a.firm || "Analyst";
  const to = a.toGrade || "";
  const from = a.fromGrade || "";
  const date = a.date ?? "";
  const label = ACTION_LABEL[act] ?? act;

  if (act === "up" || act === "upgrade" || act === "init") {
    return from && from !== to
      ? `${firm} upgraded from ${from} to ${to}${date ? ` (${date})` : ""}`
      : `${firm} rated ${to}${date ? ` (${date})` : ""}`;
  }
  if (act === "down" || act === "downgrade") {
    return from && from !== to
      ? `${firm} cut from ${from} to ${to}${date ? ` (${date})` : ""}`
      : `${firm} cut to ${to}${date ? ` (${date})` : ""}`;
  }
  if (to) return `${firm} ${label || "maintains"} ${to}${date ? ` (${date})` : ""}`;
  return null;
}

/** Build concise catalyst bullets from breakdown data already in memory — no extra API calls. */
export function buildCatalysts(input: {
  earningsDate: string | null;
  analystActions: CatalystAnalystAction[];
  news: CatalystNewsItem[];
}): string[] {
  const out: string[] = [];
  const cutoff90 = Date.now() - 90 * 86400000;

  if (input.earningsDate) {
    const days = daysUntil(input.earningsDate);
    if (days >= 0 && days <= 30) {
      out.push(days <= 14
        ? `Earnings in ${days} days (${input.earningsDate})`
        : `Earnings on ${input.earningsDate}`);
    } else if (days > 30) {
      out.push(`Next earnings ${input.earningsDate}`);
    }
  }

  const EVENT_ACTIONS = new Set(["up", "upgrade", "down", "downgrade", "init"]);
  const analystLines = input.analystActions
    .filter(a => {
      if (!EVENT_ACTIONS.has((a.action ?? "").toLowerCase())) return false;
      if (!a.date) return true;
      return new Date(a.date + "T12:00:00").getTime() >= cutoff90;
    })
    .map(analystLine)
    .filter((l): l is string => !!l)
    .slice(0, 3);
  out.push(...analystLines);

  const newsLines = input.news
    .filter(n => n.title && EVENT_KEYWORDS.test(n.title))
    .slice(0, 2)
    .map(n => n.title.trim());
  out.push(...newsLines);

  return out.slice(0, 6);
}
