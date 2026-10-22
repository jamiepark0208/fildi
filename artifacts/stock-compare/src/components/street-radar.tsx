/**
 * Street Radar (LSEG) — CSP opportunity rank for names you don't hold + risk flags on what you do.
 * Compact table; LSEG panel mounts only when a row is expanded.
 */
import { Fragment, lazy, Suspense, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { AlertTriangle, CheckCircle2, ChevronDown, ChevronRight, Info, Loader2, Radar, TrendingDown } from "lucide-react";
import { cn } from "@/lib/utils";
import { formatMdYy } from "@/lib/format";
import { GRID_WRAP, GRID_HEADER, GRID_TH, GRID_TD, gridRow } from "@/lib/score-explain-format";
import { positionRisks, rankOpportunities, type RadarRow } from "@/lib/lseg-radar";
import type { Tone } from "@/lib/lseg-interpret";
import { useAuth } from "@/context/AuthContext";

const LsegStreetPanel = lazy(() =>
  import("./lseg-street-panel").then((m) => ({ default: m.LsegStreetPanel })),
);

type RadarPayload = { available: boolean; reason?: string; coverageAt: string | null; rows: RadarRow[] };

const TONE_TEXT: Record<Tone, string> = {
  good: "text-green-400",
  bad: "text-red-400",
  warn: "text-amber-300",
  neutral: "text-white/80",
};
const TONE_ICON: Record<Tone, typeof Info> = { good: CheckCircle2, bad: TrendingDown, warn: AlertTriangle, neutral: Info };

const LABEL_CHIP: Record<string, { text: string; cls: string }> = {
  lookalike: { text: "similar", cls: "border-sky-400/50 bg-sky-500/15 text-sky-200" },
  traded: { text: "traded", cls: "border-violet-400/50 bg-violet-500/15 text-violet-200" },
  watchlist: { text: "watch", cls: "border-amber-400/50 bg-amber-500/15 text-amber-100" },
  book: { text: "book", cls: "border-zinc-500/50 bg-zinc-700/40 text-white" },
  model: { text: "model", cls: "border-emerald-400/50 bg-emerald-500/15 text-emerald-200" },
  held: { text: "held", cls: "border-green-400/50 bg-green-500/15 text-green-200" },
  benchmark: { text: "bench", cls: "border-zinc-500/50 bg-zinc-700/40 text-white" },
};

const FILTERS = ["all", "lookalike", "traded", "watchlist", "model", "book"] as const;

function ScoreBar({ score }: { score: number }) {
  const tone = score >= 65 ? "bg-green-500" : score >= 45 ? "bg-amber-400" : "bg-red-500";
  return (
    <div className="flex items-center gap-1.5 min-w-[4.5rem]">
      <div className="relative h-1.5 w-10 rounded-full bg-zinc-800 overflow-hidden">
        <div className={cn("absolute inset-y-0 left-0 rounded-full", tone)} style={{ width: `${score}%` }} />
      </div>
      <span className="font-mono text-[11px] text-white tabular-nums font-semibold">{score}</span>
    </div>
  );
}


export function StreetRadar({ embedded = false }: { embedded?: boolean }) {
  const { isAdmin } = useAuth();
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
    enabled: !!isAdmin,
    staleTime: 5 * 60 * 1000,
  });

  const rows = data?.rows ?? [];
  const opps = useMemo(() => rankOpportunities(rows), [rows]);
  const risks = useMemo(() => positionRisks(rows), [rows]);
  const filtered = filter === "all" ? opps : opps.filter((o) => o.label === filter);
  const visible = showAll ? filtered : filtered.slice(0, 10);
  const byTicker = useMemo(() => new Map(rows.map((r) => [r.ticker, r])), [rows]);
  const flagged = risks.filter((r) => r.flags.length > 0).length;

  if (!isAdmin) {
    return (
      <p className="text-[10px] text-amber-200/50 italic py-1">Street radar (LSEG) — admin only</p>
    );
  }

  return (
    <div className={cn(
      "space-y-1",
      !embedded && "rounded-md border border-[#d4af37]/25 bg-zinc-950 px-3 py-2",
    )}>
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        {!embedded && <Radar className="w-3.5 h-3.5 text-[#d4af37] shrink-0" />}
        {!embedded && (
          <span className="text-[10px] font-bold tracking-wide uppercase text-[#d4af37]">Street Radar</span>
        )}
        <div className="inline-flex rounded border border-[#d4af37]/20 overflow-hidden text-[10px] font-semibold">
          {(
            [
              ["opps", `Ideas ${opps.length}`],
              ["held", `Held${flagged ? ` · ${flagged}⚠` : ""}`],
            ] as const
          ).map(([k, label]) => (
            <button
              key={k}
              type="button"
              onClick={() => setTab(k)}
              className={cn(
                "px-2 py-0.5 transition-colors whitespace-nowrap",
                tab === k ? "bg-[#d4af37] text-black" : "bg-zinc-950 text-white/80 hover:text-[#d4af37]",
              )}
            >
              {label}
            </button>
          ))}
        </div>
        {tab === "opps" && data?.available && (
          <div className="inline-flex rounded border border-[#d4af37]/20 overflow-hidden text-[10px] font-semibold ml-auto">
            {FILTERS.map((f) => (
              <button
                key={f}
                type="button"
                onClick={() => setFilter(f)}
                className={cn(
                  "px-2 py-0.5 transition-colors whitespace-nowrap capitalize",
                  filter === f ? "bg-[#d4af37] text-black" : "bg-zinc-950 text-white/80 hover:text-[#d4af37]",
                )}
              >
                {f === "all" ? "all" : (LABEL_CHIP[f]?.text ?? f)}
              </button>
            ))}
          </div>
        )}
        <span className="text-[10px] text-white/70 tabular-nums">{rows.length} names</span>
      </div>

      {isLoading && (
        <div className="flex items-center gap-2 text-[10px] text-white py-2 justify-center">
          <Loader2 className="w-3 h-3 animate-spin" /> Loading…
        </div>
      )}
      {error && <p className="text-[9px] text-red-400 italic">{(error as Error).message}</p>}
      {data && !data.available && <p className="text-[9px] text-amber-300 italic">{data.reason}</p>}

      {data?.available && tab === "opps" && (
        <>
          <div className={GRID_WRAP}>
            <table className="w-full border-collapse">
              <thead>
                <tr className={GRID_HEADER}>
                  <th className={cn(GRID_TH, "w-6 text-center py-0.5")} />
                  <th className={cn(GRID_TH, "w-8 text-center py-0.5")}>#</th>
                  <th className={cn(GRID_TH, "text-left py-0.5")}>Tkr</th>
                  <th className={cn(GRID_TH, "text-left py-0.5")}>Score</th>
                  <th className={cn(GRID_TH, "text-left py-0.5")}>Why</th>
                  <th className={cn(GRID_TH, "text-right py-0.5")}>IV · ER</th>
                </tr>
              </thead>
              <tbody>
                {visible.map((o, i) => {
                  const r = byTicker.get(o.ticker)!;
                  const isOpen = open === o.ticker;
                  const chip = LABEL_CHIP[o.label] ?? LABEL_CHIP.book;
                  const wt = (o.bullets.find((b) => b.text === o.why) ?? o.bullets[0])?.tone ?? "neutral";
                  return (
                    <Fragment key={o.ticker}>
                      <tr
                        className={cn(gridRow(i), "cursor-pointer")}
                        onClick={() => setOpen(isOpen ? null : o.ticker)}
                      >
                        <td className={cn(GRID_TD, "py-0.5 text-center")}>
                          {isOpen
                            ? <ChevronDown className="w-3 h-3 text-white/70 inline-block" />
                            : <ChevronRight className="w-3 h-3 text-white/70 inline-block" />}
                        </td>
                        <td className={cn(GRID_TD, "py-0.5 text-center text-white/70 font-mono text-[11px]")}>{i + 1}</td>
                        <td className={cn(GRID_TD, "py-0.5 font-mono font-bold text-white")}>{o.ticker}</td>
                        <td className={cn(GRID_TD, "py-0.5")}><ScoreBar score={o.score} /></td>
                        <td className={cn(GRID_TD, "py-0.5 text-[11px] max-w-0")}>
                          <span className="truncate block">
                            <span className={cn("mr-1 px-1 py-px rounded border text-[9px] font-semibold", chip.cls)}>{chip.text}</span>
                            <span className={cn(TONE_TEXT[wt])}>{o.why}</span>
                          </span>
                        </td>
                        <td className={cn(GRID_TD, "py-0.5 text-right font-mono text-[11px] whitespace-nowrap")}>
                          {r.tech.iv != null && <span className="text-sky-300">{r.tech.iv.toFixed(0)}%</span>}
                          {r.nextEarnings && (
                            <span className={cn("ml-1.5", r.nextEarnings.daysUntil <= 35 ? "text-amber-300 font-semibold" : "text-white/80")}>
                              {formatMdYy(r.nextEarnings.date)}
                            </span>
                          )}
                        </td>
                      </tr>
                      {isOpen && (
                        <tr className="border-b border-[#d4af37]/10">
                          <td colSpan={6} className="px-2 pb-2 pt-1 bg-black/40">
                            <Suspense
                              fallback={
                                <div className="flex items-center gap-1.5 text-[10px] text-white py-1">
                                  <Loader2 className="w-3 h-3 animate-spin" /> LSEG…
                                </div>
                              }
                            >
                              <LsegStreetPanel ticker={o.ticker} embedded />
                            </Suspense>
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
          {filtered.length > 10 && (
            <button type="button" onClick={() => setShowAll(!showAll)} className="text-[10px] text-white/80 hover:text-white">
              {showAll ? "Show top 10" : `Show all ${filtered.length}`}
            </button>
          )}
        </>
      )}

      {data?.available && tab === "held" && (
        <div className={GRID_WRAP}>
          <table className="w-full border-collapse">
            <thead>
              <tr className={GRID_HEADER}>
                <th className={cn(GRID_TH, "w-6 text-center py-0.5")} />
                <th className={cn(GRID_TH, "text-left py-0.5")}>Tkr</th>
                <th className={cn(GRID_TH, "text-left py-0.5")}>Flag</th>
                <th className={cn(GRID_TH, "text-left py-0.5")}>Verdict</th>
              </tr>
            </thead>
            <tbody>
              {risks.map((p, i) => {
                const isOpen = open === p.ticker;
                const Icon = TONE_ICON[p.tone];
                return (
                  <Fragment key={p.ticker}>
                    <tr
                      className={cn(gridRow(i), "cursor-pointer")}
                      onClick={() => setOpen(isOpen ? null : p.ticker)}
                    >
                      <td className={cn(GRID_TD, "py-0.5 text-center")}>
                        {isOpen
                          ? <ChevronDown className="w-3 h-3 text-white/70 inline-block" />
                          : <ChevronRight className="w-3 h-3 text-white/70 inline-block" />}
                      </td>
                      <td className={cn(GRID_TD, "py-0.5 font-mono font-bold text-white")}>{p.ticker}</td>
                      <td className={cn(GRID_TD, "py-0.5")}>
                        <Icon className={cn("w-3.5 h-3.5", TONE_TEXT[p.tone])} />
                      </td>
                      <td className={cn(GRID_TD, "py-0.5 text-[11px]")}>
                        <span className={cn(TONE_TEXT[p.tone])}>{p.verdict}</span>
                        {p.flags.length > 0 && (
                          <span className="text-white/60 ml-1.5">
                            · {p.flags.slice(0, 2).map((f) => f.title).join(" · ")}
                          </span>
                        )}
                      </td>
                    </tr>
                    {isOpen && (
                      <tr className="border-b border-[#d4af37]/10">
                        <td colSpan={4} className="px-2 pb-2 pt-1 bg-black/40">
                          <Suspense
                            fallback={
                              <div className="flex items-center gap-1.5 text-[10px] text-white py-1">
                                <Loader2 className="w-3 h-3 animate-spin" /> LSEG…
                              </div>
                            }
                          >
                            <LsegStreetPanel ticker={p.ticker} embedded />
                          </Suspense>
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
