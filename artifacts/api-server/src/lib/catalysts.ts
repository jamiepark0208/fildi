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

function daysUntil(iso: string): number {
  const d = new Date(iso + "T12:00:00").getTime();
  return Math.round((d - Date.now()) / 86400000);
}

function analystLine(a: CatalystAnalystAction): string | null {
  const act = (a.action ?? "").toLowerCase();
  const firm = a.firm || "Analyst";
  const to = a.toGrade || "";
  const from = a.fromGrade || "";
  const date = a.date ?? "";
  if (act.includes("upgrade") || act.includes("up") || act.includes("init")) {
    return from
      ? `${firm} upgraded from ${from} to ${to}${date ? ` (${date})` : ""}`
      : `${firm} rated ${to}${date ? ` (${date})` : ""}`;
  }
  if (act.includes("downgrade") || act.includes("down")) {
    return from
      ? `${firm} cut from ${from} to ${to}${date ? ` (${date})` : ""}`
      : `${firm} cut to ${to}${date ? ` (${date})` : ""}`;
  }
  if (to) return `${firm} ${act || "maintains"} ${to}${date ? ` (${date})` : ""}`;
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

  const analystLines = input.analystActions
    .filter(a => {
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
