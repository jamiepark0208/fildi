/**
 * Street Radar (LSEG) — opportunities you don't hold + risk flags on what you do.
 * Compact table UI; LSEG panel mounts only when a row is expanded.
 */
import { lazy, Suspense, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { AlertTriangle, CheckCircle2, ChevronDown, ChevronRight, Info, Loader2, Radar, TrendingDown } from "lucide-react";
import { cn } from "@/lib/utils";
import { positionRisks, rankOpportunities, type RadarRow } from "@/lib/lseg-radar";
import type { Tone } from "@/lib/lseg-interpret";

const LsegStreetPanel = lazy(() =>
  import("./lseg-street-panel").then((m) => ({ default: m.LsegStreetPanel })),
);

type RadarPayload = { available: boolean; reason?: string; coverageAt: string | null; rows: RadarRow[] };

const TONE_TEXT: Record<Tone, string> = {
  good: "text-green-400",
  bad: "text-red-400",
  warn: "text-amber-300",
  neutral: "text-zinc-400",
};
const TONE_ICON: Record<Tone, typeof Info> = { good: CheckCircle2, bad: TrendingDown, warn: AlertTriangle, neutral: Info };

const LABEL_CHIP: Record<string, { text: string; cls: string }> = {
  lookalike: { text: "lookalike", cls: "border-sky-500/30 text-sky-300" },
  traded: { text: "traded", cls: "border-violet-500/30 text-violet-300" },
  watchlist: { text: "watch", cls: "border-amber-400/30 text-amber-200" },
  book: { text: "book", cls: "border-zinc-600 text-zinc-400" },
  held: { text: "held", cls: "border-green-500/30 text-green-300" },
};

const FILTERS = ["all", "lookalike", "traded", "watchlist", "book"] as const;

const ROW =
  "grid grid-cols-[1rem_1.25rem_2.75rem_4.5rem_minmax(0,1fr)_auto] items-center gap-x-1.5 text-[10px] py-0.5";

function ScoreBar({ score }: { score: number }) {
  const tone = score >= 65 ? "bg-green-500/80" : score >= 45 ? "bg-zinc-400/70" : "bg-red-500/70";
  return (
    <div className="flex items-center gap-1 w-[4.5rem] shrink-0">
      <div className="relative h-1 flex-1 rounded-full bg-zinc-800 overflow-hidden">
        <div className={cn("absolute inset-y-0 left-0 rounded-full", tone)} style={{ width: `${score}%` }} />
      </div>
      <span className="font-mono text-[9px] text-zinc-300 w-5 text-right">{score}</span>
    </div>
  );
}

export function StreetRadar() {
  const [tab, setTab] = useState<"opps" | "held">("opps");
  const [filter, setFilter] = useState<(typeof FILTERS)[number]>("all");
  const [open, setOpen] = useState<string | null>(null);
  const [showAll, setShowAll] = useState(false);

  const { data, isLoading, error } = useQuery({
    queryKey: ["research-lseg-radar"],
    queryFn: async (): Promise<RadarPayload> => {
      const res = await fetch("/api/research/lseg/radar");
      if (!res.ok) throw new Error(`LSEG radar ${res.status}`);
      return res.json();
    },
    staleTime: 5 * 60 * 1000,
  });

  const rows = data?.rows ?? [];
  const opps = useMemo(() => rankOpportunities(rows), [rows]);
  const risks = useMemo(() => positionRisks(rows), [rows]);
  const filtered = filter === "all" ? opps : opps.filter((o) => o.label === filter);
  const visible = showAll ? filtered : filtered.slice(0, 10);
  const byTicker = useMemo(() => new Map(rows.map((r) => [r.ticker, r])), [rows]);
  const flagged = risks.filter((r) => r.flags.length > 0).length;

  return (
    <div className="rounded-md border border-[#d4af37]/25 bg-zinc-950 px-3 py-2 space-y-1.5">
      <div className="flex flex-wrap items-center justify-between gap-1.5">
        <div className="flex items-center gap-1.5 min-w-0">
          <Radar className="w-3.5 h-3.5 text-[#d4af37] shrink-0" />
          <span className="text-[10px] font-bold tracking-wide uppercase text-[#d4af37]">Street Radar · LSEG</span>
          <span className="text-[9px] text-zinc-500 truncate">
            {rows.length} names{data?.coverageAt ? ` · ${data.coverageAt}` : ""}
          </span>
        </div>
        <div className="flex gap-0.5 text-[9px]">
          {(
            [
              ["opps", `Opps ${opps.length}`],
              ["held", `Held${flagged ? ` · ${flagged}⚠` : ""}`],
            ] as const
          ).map(([k, label]) => (
            <button
              key={k}
              onClick={() => setTab(k)}
              className={cn(
                "px-1.5 py-0.5 rounded border",
                tab === k ? "border-[#d4af37]/50 text-[#d4af37] bg-amber-500/10" : "border-zinc-800 text-zinc-500 hover:text-zinc-300",
              )}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      {isLoading && (
        <div className="flex items-center gap-2 text-[10px] text-muted-foreground py-2 justify-center">
          <Loader2 className="w-3 h-3 animate-spin" /> Loading…
        </div>
      )}
      {error && <p className="text-[9px] text-red-400/80 italic">{(error as Error).message}</p>}
      {data && !data.available && <p className="text-[9px] text-amber-200/50 italic">{data.reason}</p>}

      {data?.available && tab === "opps" && (
        <>
          <div className="flex flex-wrap items-center justify-between gap-1">
            <p className="text-[9px] text-zinc-500 max-w-2xl leading-snug">
              CSP rank: Street momentum · premium richness · entry timing. Expand a row for LSEG detail.
            </p>
            <div className="flex gap-0.5 text-[9px]">
              {FILTERS.map((f) => (
                <button
                  key={f}
                  onClick={() => setFilter(f)}
                  className={cn(
                    "px-1 py-0.5 rounded border",
                    filter === f ? "border-zinc-500 text-zinc-100" : "border-zinc-800 text-zinc-600 hover:text-zinc-300",
                  )}
                >
                  {f === "all" ? "all" : LABEL_CHIP[f].text}
                </button>
              ))}
            </div>
          </div>

          <div className="divide-y divide-zinc-800/60 border border-zinc-800/50 rounded overflow-hidden">
            <div className={cn(ROW, "px-1.5 bg-zinc-950 text-[8px] uppercase tracking-wider text-zinc-600")}>
              <span />
              <span>#</span>
              <span>Tkr</span>
              <span>Score</span>
              <span>Why</span>
              <span className="text-right">Meta</span>
            </div>
            {visible.map((o, i) => {
              const r = byTicker.get(o.ticker)!;
              const isOpen = open === o.ticker;
              const chip = LABEL_CHIP[o.label] ?? LABEL_CHIP.book;
              return (
                <div key={o.ticker} className="bg-zinc-900/40">
                  <button onClick={() => setOpen(isOpen ? null : o.ticker)} className="w-full text-left px-1.5 hover:bg-amber-500/5">
                    <div className={ROW}>
                      {isOpen ? <ChevronDown className="w-3 h-3 text-zinc-500" /> : <ChevronRight className="w-3 h-3 text-zinc-500" />}
                      <span className="text-zinc-600 font-mono">{i + 1}</span>
                      <span className="font-mono font-bold text-zinc-100">{o.ticker}</span>
                      <ScoreBar score={o.score} />
                      <span className="truncate text-zinc-500">
                        <span className={cn("mr-1 px-1 py-px rounded border text-[8px]", chip.cls)}>{chip.text}</span>
                        {o.why}
                      </span>
                      <span className="flex gap-2 font-mono text-[9px] text-zinc-500 shrink-0">
                        {r.tech.iv != null && <span>IV {r.tech.iv.toFixed(0)}</span>}
                        {r.nextEarnings && (
                          <span className={r.nextEarnings.daysUntil <= 35 ? "text-amber-300" : ""}>ER {r.nextEarnings.daysUntil}d</span>
                        )}
                      </span>
                    </div>
                  </button>
                  {isOpen && (
                    <div className="px-2 pb-2 max-w-3xl">
                      <Suspense
                        fallback={
                          <div className="flex items-center gap-1.5 text-[10px] text-zinc-500 py-2">
                            <Loader2 className="w-3 h-3 animate-spin" /> LSEG…
                          </div>
                        }
                      >
                        <LsegStreetPanel ticker={o.ticker} />
                      </Suspense>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
          {filtered.length > 10 && (
            <button onClick={() => setShowAll(!showAll)} className="text-[9px] text-zinc-500 hover:text-zinc-300">
              {showAll ? "Show top 10" : `Show all ${filtered.length}`}
            </button>
          )}
        </>
      )}

      {data?.available && tab === "held" && (
        <div className="divide-y divide-zinc-800/60 border border-zinc-800/50 rounded overflow-hidden">
          {risks.map((p) => {
            const isOpen = open === p.ticker;
            const Icon = TONE_ICON[p.tone];
            return (
              <div key={p.ticker} className="bg-zinc-900/40">
                <button onClick={() => setOpen(isOpen ? null : p.ticker)} className="w-full text-left px-1.5 py-0.5 hover:bg-amber-500/5">
                  <div className="grid grid-cols-[1rem_2.75rem_1rem_minmax(0,1fr)] items-center gap-x-1.5 text-[10px]">
                    {isOpen ? <ChevronDown className="w-3 h-3 text-zinc-500" /> : <ChevronRight className="w-3 h-3 text-zinc-500" />}
                    <span className="font-mono font-bold text-zinc-100">{p.ticker}</span>
                    <Icon className={cn("w-3 h-3 shrink-0", TONE_TEXT[p.tone])} />
                    <span className={cn("truncate", TONE_TEXT[p.tone])}>{p.verdict}</span>
                  </div>
                  {p.flags.length > 0 && (
                    <div className="pl-8 text-[9px] text-zinc-500 truncate">
                      {p.flags.slice(0, 2).map((f) => f.title).join(" · ")}
                    </div>
                  )}
                </button>
                {isOpen && (
                  <div className="px-2 pb-2 max-w-3xl">
                    <Suspense
                      fallback={
                        <div className="flex items-center gap-1.5 text-[10px] text-zinc-500 py-2">
                          <Loader2 className="w-3 h-3 animate-spin" /> LSEG…
                        </div>
                      }
                    >
                      <LsegStreetPanel ticker={p.ticker} />
                    </Suspense>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      <p className="text-[8px] text-zinc-600 leading-snug">
        Local LSEG cache + technicals · not a fund/tech score input · refresh via{" "}
        <span className="font-mono">research/lseg/sync_signals.py</span>
      </p>
    </div>
  );
}
