import { useMemo } from "react";

interface CatalystAnalystAction {
  firm: string;
  toGrade: string;
  fromGrade: string;
  action: string;
  date: string | null;
}

interface CatalystNewsItem {
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

function buildCatalysts(input: {
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

interface CatalystsSectionProps {
  catalysts?: string[];
  earningsDate?: string | null;
  analystActions?: CatalystAnalystAction[];
  news?: CatalystNewsItem[];
}

export function CatalystsSection({
  catalysts,
  earningsDate,
  analystActions,
  news,
}: CatalystsSectionProps) {
  const lines = useMemo(() => {
    if (catalysts && catalysts.length > 0) return catalysts;
    return buildCatalysts({
      earningsDate: earningsDate ?? null,
      analystActions: analystActions ?? [],
      news: news ?? [],
    });
  }, [catalysts, earningsDate, analystActions, news]);

  if (!lines.length) {
    return (
      <div className="bg-card border border-border/50 rounded-xl p-4">
        <span className="text-base font-bold tracking-tight text-foreground block">Event Risk / Catalysts</span>
        <p className="text-sm text-foreground/55 mt-2">No upcoming catalysts identified.</p>
      </div>
    );
  }

  return (
    <div className="bg-card border border-border/50 rounded-xl p-4">
      <span className="text-base font-bold tracking-tight text-foreground block mb-2">Event Risk / Catalysts</span>
      <ul className="space-y-1.5">
        {lines.map((line, i) => (
          <li key={i} className="flex gap-2 text-sm text-foreground/85 leading-snug">
            <span className="shrink-0 text-foreground/40 mt-0.5">•</span>
            {line}
          </li>
        ))}
      </ul>
    </div>
  );
}
