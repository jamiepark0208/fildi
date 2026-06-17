import {
  TrendingUp,
  TrendingDown,
  Globe,
  Calendar,
  BarChart3,
  Layers,
  Eye,
  AlertTriangle,
  Sparkles,
} from "lucide-react";
import { cn } from "@/lib/utils";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface MacroHighlightsBullet {
  id: string;
  category: "tape" | "macro" | "sector" | "watchlist" | "event" | "geopolitical";
  title: string;
  body: string;
  tags?: string[];
  tickers?: string[];
  metric?: { label: string; value: string; direction?: "up" | "down" | "flat" };
}

export interface MacroHighlightsData {
  generatedAt: string;
  marketDate: string;
  headline: string;
  eventsToday: { date: string; event: string; importance: "high" | "medium" | "low" }[];
  bullets: MacroHighlightsBullet[];
  watchlistMovers: { ticker: string; changePct: number; blurb: string }[];
}

// ── Helpers ───────────────────────────────────────────────────────────────────

const CATEGORY_ICON: Record<MacroHighlightsBullet["category"], typeof Globe> = {
  tape: BarChart3,
  macro: Globe,
  sector: Layers,
  watchlist: Eye,
  event: Calendar,
  geopolitical: AlertTriangle,
};

function importanceDot(importance: "high" | "medium" | "low") {
  if (importance === "high") return "bg-red-400";
  if (importance === "medium") return "bg-yellow-400";
  return "bg-muted-foreground";
}

function fmtTs(iso: string) {
  return new Date(iso).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function pctColor(pct: number) {
  if (pct > 0) return "text-green-400";
  if (pct < 0) return "text-red-400";
  return "text-muted-foreground";
}

// ── Component ─────────────────────────────────────────────────────────────────

export function MacroHighlightsPanel({
  data,
  legacy,
}: {
  data?: MacroHighlightsData | null;
  legacy?: boolean;
}) {
  if (legacy) {
    return (
      <p className="text-sm text-muted-foreground py-2">
        Highlights format updated — click Generate for the new scannable brief.
      </p>
    );
  }

  if (!data) return null;

  return (
    <div className="space-y-4">
      <p className="text-lg font-bold text-foreground leading-snug">{data.headline}</p>

      {data.eventsToday.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {data.eventsToday.map((ev) => (
            <span
              key={`${ev.date}-${ev.event}`}
              className="inline-flex items-center gap-1.5 text-xs px-2.5 py-1 rounded-full bg-secondary/60 border border-border/50 text-foreground"
            >
              <span className={cn("w-1.5 h-1.5 rounded-full shrink-0", importanceDot(ev.importance))} />
              <Calendar className="w-3 h-3 text-muted-foreground" />
              {ev.event}
            </span>
          ))}
        </div>
      )}

      <div className="space-y-2">
        {data.bullets.map((b) => {
          const Icon = CATEGORY_ICON[b.category] ?? Sparkles;
          return (
            <div
              key={b.id}
              className="rounded-lg border border-border/50 bg-background/40 px-3 py-2.5 space-y-1"
            >
              <div className="flex items-start gap-2">
                <Icon className="w-4 h-4 mt-0.5 text-primary shrink-0" />
                <div className="min-w-0 flex-1">
                  <p className="text-base font-semibold text-foreground">{b.title}</p>
                  <p className="text-sm text-foreground/90 leading-snug">{b.body}</p>
                  <div className="flex flex-wrap gap-1.5 mt-1.5">
                    {b.tickers?.map((t) => (
                      <span
                        key={t}
                        className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-primary/10 text-primary border border-primary/20"
                      >
                        {t}
                      </span>
                    ))}
                    {b.tags?.map((tag) => (
                      <span
                        key={tag}
                        className="text-[10px] px-1.5 py-0.5 rounded bg-secondary text-muted-foreground"
                      >
                        {tag}
                      </span>
                    ))}
                    {b.metric && (
                      <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-secondary/80 text-foreground">
                        {b.metric.label}: {b.metric.value}
                      </span>
                    )}
                  </div>
                </div>
              </div>
            </div>
          );
        })}
      </div>

      {data.watchlistMovers.length > 0 && (
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
          {data.watchlistMovers.slice(0, 3).map((m) => {
            const up = m.changePct > 0;
            const down = m.changePct < 0;
            const Icon = up ? TrendingUp : down ? TrendingDown : BarChart3;
            return (
              <div
                key={m.ticker}
                className="rounded-lg border border-border/50 bg-secondary/20 px-3 py-2 space-y-1"
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="font-mono font-semibold text-sm">{m.ticker}</span>
                  <span className={cn("text-xs font-mono flex items-center gap-0.5", pctColor(m.changePct))}>
                    <Icon className="w-3 h-3" />
                    {m.changePct > 0 ? "+" : ""}
                    {m.changePct.toFixed(2)}%
                  </span>
                </div>
                <p className="text-xs text-muted-foreground leading-snug line-clamp-2">{m.blurb}</p>
              </div>
            );
          })}
        </div>
      )}

      <p className="text-[10px] text-muted-foreground/70">
        Generated {fmtTs(data.generatedAt)}
      </p>
    </div>
  );
}
