import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useAuth } from "@/context/AuthContext";
import {
  Activity,
  AlertTriangle,
  Calendar,
  ChevronDown,
  ChevronUp,
  DollarSign,
  Loader2,
  Newspaper,
  RefreshCw,
  Sparkles,
  TrendingDown,
  TrendingUp,
  BarChart2,
} from "lucide-react";
import { useState } from "react";
import { cn } from "@/lib/utils";

// ── Types ─────────────────────────────────────────────────────────────────────

interface EventToday {
  date: string;
  event: string;
  importance: "high" | "medium" | "low";
}

interface Metric {
  label: string;
  value: string;
  direction: "up" | "down" | "flat";
}

interface Bullet {
  id: string;
  category: "tape" | "macro" | "sector" | "watchlist" | "event" | "geopolitical";
  title: string;
  body: string;
  tags?: string[];
  tickers?: string[];
  metric?: Metric;
}

interface WatchlistMover {
  ticker: string;
  changePct: number;
  blurb: string;
}

interface HighlightsPayload {
  generatedAt: string;
  marketDate: string;
  headline: string;
  eventsToday: EventToday[];
  bullets: Bullet[];
  watchlistMovers: WatchlistMover[];
}

type HighlightsResponse =
  | HighlightsPayload
  | { noData: true }
  | { legacy: true };

// ── Helpers ───────────────────────────────────────────────────────────────────

const CATEGORY_META: Record<
  Bullet["category"],
  { icon: React.ComponentType<{ className?: string }>; color: string; label: string }
> = {
  tape:         { icon: Activity,      color: "text-blue-400",   label: "Tape"        },
  macro:        { icon: DollarSign,    color: "text-yellow-400", label: "Macro"       },
  sector:       { icon: BarChart2,     color: "text-purple-400", label: "Sector"      },
  watchlist:    { icon: Newspaper,     color: "text-green-400",  label: "Watchlist"   },
  event:        { icon: Calendar,      color: "text-orange-400", label: "Event"       },
  geopolitical: { icon: AlertTriangle, color: "text-red-400",    label: "Geo"         },
};

const IMPORTANCE_BADGE: Record<EventToday["importance"], string> = {
  high:   "bg-red-900/60 text-red-300 border-red-700/50",
  medium: "bg-yellow-900/60 text-yellow-300 border-yellow-700/50",
  low:    "bg-zinc-800 text-zinc-400 border-zinc-700",
};

function fmtTime(iso: string) {
  try {
    return new Date(iso).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
  } catch {
    return "";
  }
}

function fmtDate(iso: string) {
  try {
    return new Date(iso + "T12:00:00").toLocaleDateString("en-US", { month: "short", day: "numeric" });
  } catch {
    return iso;
  }
}

// ── Sub-components ────────────────────────────────────────────────────────────

function EventsStrip({ events }: { events: EventToday[] }) {
  if (!events.length) return null;
  return (
    <div className="flex flex-wrap gap-1.5">
      {events.map((e, i) => (
        <span
          key={i}
          className={cn(
            "inline-flex items-center gap-1 text-[10px] font-medium px-2 py-0.5 rounded border",
            IMPORTANCE_BADGE[e.importance]
          )}
        >
          <Calendar className="h-2.5 w-2.5 shrink-0" />
          {e.event}
        </span>
      ))}
    </div>
  );
}

function BulletRow({ bullet }: { bullet: Bullet }) {
  const meta = CATEGORY_META[bullet.category];
  const Icon = meta.icon;
  return (
    <div className="flex gap-2.5 py-2 border-b border-border/40 last:border-0">
      <div className={cn("mt-0.5 shrink-0", meta.color)}>
        <Icon className="h-3.5 w-3.5" />
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
          <span className="text-xs font-semibold text-foreground leading-snug">{bullet.title}</span>
          {bullet.tickers?.map((t) => (
            <span key={t} className="text-[10px] font-mono bg-zinc-800 text-zinc-300 px-1 py-0 rounded">
              {t}
            </span>
          ))}
        </div>
        <p className="text-[11px] text-muted-foreground leading-snug mt-0.5">{bullet.body}</p>
        {bullet.metric && (
          <span className="inline-flex items-center gap-1 mt-1 text-[10px] font-medium">
            {bullet.metric.direction === "up"   && <TrendingUp   className="h-3 w-3 text-green-400" />}
            {bullet.metric.direction === "down" && <TrendingDown className="h-3 w-3 text-red-400"   />}
            <span className={cn(
              bullet.metric.direction === "up"   ? "text-green-400"
              : bullet.metric.direction === "down" ? "text-red-400"
              : "text-zinc-400"
            )}>
              {bullet.metric.label}: {bullet.metric.value}
            </span>
          </span>
        )}
      </div>
    </div>
  );
}

function MoversStrip({ movers }: { movers: WatchlistMover[] }) {
  if (!movers.length) return null;
  return (
    <div className="flex flex-wrap gap-2 pt-2 border-t border-border/40">
      {movers.map((m) => (
        <div
          key={m.ticker}
          className="flex items-center gap-1.5 bg-zinc-900 border border-zinc-800 rounded px-2 py-1"
          title={m.blurb}
        >
          <span className="text-[11px] font-mono font-semibold text-foreground">{m.ticker}</span>
          <span className={cn(
            "text-[11px] font-medium",
            m.changePct >= 0 ? "text-green-400" : "text-red-400"
          )}>
            {m.changePct >= 0 ? "+" : ""}{m.changePct.toFixed(2)}%
          </span>
        </div>
      ))}
    </div>
  );
}

// ── Main panel ────────────────────────────────────────────────────────────────

export function MacroHighlightsPanel() {
  const { isAdmin } = useAuth();
  const qc = useQueryClient();
  const [open, setOpen] = useState(true);

  const { data, isLoading } = useQuery<HighlightsResponse>({
    queryKey: ["macro-highlights"],
    queryFn: () => fetch("/api/macro/highlights").then((r) => r.json()),
    staleTime: Infinity,
    refetchOnWindowFocus: false,
  });

  const generateMutation = useMutation({
    mutationFn: () =>
      fetch("/api/macro/highlights/generate", { method: "POST" }).then((r) => r.json()),
    onSuccess: (d) => qc.setQueryData(["macro-highlights"], d),
  });

  const payload =
    data && !("noData" in data) && !("legacy" in data)
      ? (data as HighlightsPayload)
      : null;

  const isLegacy = data && "legacy" in data;
  const isEmpty  = !payload && !isLegacy && !generateMutation.isPending;

  return (
    <div className="bg-secondary/30 rounded-lg border border-border">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-border/60">
        <h2 className="text-sm font-bold tracking-tight flex items-center gap-2">
          <Sparkles className="h-4 w-4 text-primary" />
          AI Highlights
          {payload && (
            <span className="text-[10px] text-muted-foreground font-normal ml-1">
              {fmtDate(payload.marketDate)} · {fmtTime(payload.generatedAt)}
            </span>
          )}
        </h2>
        <div className="flex items-center gap-2">
          {isAdmin && (
            <button
              onClick={() => generateMutation.mutate()}
              disabled={generateMutation.isPending}
              className="flex items-center gap-1.5 text-xs px-3 py-1 rounded-md bg-primary/10 hover:bg-primary/20 border border-primary/30 text-primary transition-colors disabled:opacity-50"
            >
              {generateMutation.isPending
                ? <Loader2 className="h-3 w-3 animate-spin" />
                : <RefreshCw className="h-3 w-3" />}
              Generate
            </button>
          )}
          <button
            onClick={() => setOpen((o) => !o)}
            className="text-muted-foreground hover:text-foreground transition-colors"
          >
            {open ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
          </button>
        </div>
      </div>

      {/* Body */}
      {open && (
        <div className="px-4 py-3 space-y-3">

          {/* Loading spinner (initial page load) */}
          {isLoading && (
            <div className="flex items-center gap-2 py-4 justify-center">
              <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
              <span className="text-xs text-muted-foreground">Loading…</span>
            </div>
          )}

          {/* Generating spinner */}
          {generateMutation.isPending && (
            <div className="flex items-center gap-2 py-6 justify-center">
              <Loader2 className="h-4 w-4 animate-spin text-primary" />
              <span className="text-xs text-muted-foreground">
                Fetching news, market data, and calendar events…
              </span>
            </div>
          )}

          {/* Legacy cache notice */}
          {!generateMutation.isPending && isLegacy && (
            <p className="text-xs text-muted-foreground italic py-2">
              Format updated — click Generate to refresh.
            </p>
          )}

          {/* Empty state */}
          {!isLoading && !generateMutation.isPending && isEmpty && (
            <p className="text-xs text-muted-foreground italic py-2">
              No highlights yet — click Generate for today's brief.
            </p>
          )}

          {/* Payload */}
          {!generateMutation.isPending && payload && (
            <>
              {/* Headline */}
              <p className="text-sm font-semibold text-foreground leading-snug">
                {payload.headline}
              </p>

              {/* Today's events */}
              <EventsStrip events={payload.eventsToday} />

              {/* Bullets */}
              {payload.bullets.length > 0 && (
                <div className="divide-y divide-transparent">
                  {payload.bullets.map((b) => (
                    <BulletRow key={b.id} bullet={b} />
                  ))}
                </div>
              )}

              {/* Watchlist movers strip */}
              <MoversStrip movers={payload.watchlistMovers} />
            </>
          )}
        </div>
      )}
    </div>
  );
}
