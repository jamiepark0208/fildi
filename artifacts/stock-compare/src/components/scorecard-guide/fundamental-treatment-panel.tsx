/**
 * Visual Scorecard Guide — fundamental engine flow (matches fund-score-style assignStyleBucket).
 * Optional ticker pulls persisted rankings row for a live walkthrough.
 */
import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Search } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  STYLE_FAMILY_WEIGHTS,
  ENGINE_METRICS,
  CROSS_SECTION_BLEND,
  type StyleBucket,
  type FamilyName,
} from "@/lib/fund-score-treatments";
import type { StockScore } from "@/lib/rankings";
import { familyWeightsForStyle } from "@/lib/fundamental-scoring-meta";

const pct = (w: number) => CROSS_SECTION_BLEND.pct(w);
const FAM: FamilyName[] = ["value", "growth", "quality", "safety"];
const FAM_COLOR: Record<FamilyName, string> = {
  value: "bg-sky-500",
  growth: "bg-emerald-500",
  quality: "bg-violet-500",
  safety: "bg-amber-500",
};

const PIPELINE: { id: string; title: string; detail: string }[] = [
  { id: "load", title: "Load", detail: "Gold fundamentals + peer group" },
  {
    id: "rank",
    title: "Rank",
    detail: `${pct(CROSS_SECTION_BLEND.peer)}% peers · ${pct(CROSS_SECTION_BLEND.sector)}% sector · ${pct(CROSS_SECTION_BLEND.universe)}% universe`,
  },
  { id: "style", title: "Style", detail: "Gate → weights + metric exclusions" },
  { id: "family", title: "Families", detail: "Value · Growth · Quality · Safety" },
  { id: "blend", title: "Total", detail: "90% company + 10% peer-group opportunity" },
];

/** Decision order = assignStyleBucket (fund-score-style.ts). */
const STYLE_GATES: { q: string; yes: string; no?: string }[] = [
  { q: "Pre-revenue / tiny + losing?", yes: "pre_revenue", no: "↓" },
  { q: "Bank / insurer / REIT?", yes: "financial", no: "↓" },
  { q: "Defensive peer + not expensive?", yes: "quality_defensive", no: "↓" },
  { q: "Operating but unprofitable?", yes: "growth if fast, else blend", no: "↓" },
  { q: "Cheap + growing (GARP)?", yes: "garp", no: "↓" },
  { q: "Cheap, slow?", yes: "value", no: "↓" },
  { q: "Fast, expensive?", yes: "growth", no: "blend / quality" },
];

function FamilyBars({ weights, highlight }: { weights: Record<FamilyName, number>; highlight?: StyleBucket | null }) {
  return (
    <div className="flex h-3 w-full overflow-hidden rounded-sm border border-white/10">
      {FAM.map((f) => (
        <div
          key={f}
          className={cn(FAM_COLOR[f], "transition-all", highlight && "opacity-90")}
          style={{ width: `${weights[f]}%` }}
          title={`${f} ${weights[f]}%`}
        />
      ))}
    </div>
  );
}

function PipelineStrip({ activeStyle }: { activeStyle?: string | null }) {
  return (
    <div className="flex flex-wrap items-stretch gap-1.5">
      {PIPELINE.map((step, i) => (
        <div key={step.id} className="flex items-center gap-1.5 min-w-0">
          <div
            className={cn(
              "rounded-md border px-2.5 py-2 min-w-[7.5rem] flex-1",
              step.id === "style" && activeStyle
                ? "border-[#d4af37]/50 bg-[#d4af37]/10"
                : "border-[#d4af37]/20 bg-black/50",
            )}
          >
            <div className="text-[9px] font-bold uppercase tracking-wider text-[#d4af37]/80">
              {i + 1}. {step.title}
            </div>
            <div className="text-[10px] text-white mt-0.5 leading-snug">{step.detail}</div>
            {step.id === "style" && activeStyle && (
              <div className="text-[10px] font-semibold text-[#d4af37] mt-1 capitalize">
                → {activeStyle.replace(/_/g, " ")}
              </div>
            )}
          </div>
          {i < PIPELINE.length - 1 && (
            <span className="text-[#d4af37]/40 text-sm shrink-0 hidden sm:inline" aria-hidden>
              →
            </span>
          )}
        </div>
      ))}
    </div>
  );
}

function StyleTree() {
  return (
    <div className="rounded-md border border-[#d4af37]/20 bg-black/40 p-2.5 space-y-1">
      <div className="text-[10px] font-semibold uppercase tracking-wide text-[#d4af37]/80 mb-1.5">
        Style gate (first match wins)
      </div>
      {STYLE_GATES.map((g, i) => (
        <div key={g.q} className="grid grid-cols-[auto_1fr_auto] gap-x-2 items-center text-[10px]">
          <span className="font-mono text-[#d4af37]/50 w-4">{i + 1}</span>
          <span className="text-white">{g.q}</span>
          <span className="text-emerald-400/90 font-medium text-right whitespace-nowrap">{g.yes}</span>
        </div>
      ))}
    </div>
  );
}

function TickerWalkthrough() {
  const [input, setInput] = useState("");
  const [ticker, setTicker] = useState("");

  const { data: rankings, isFetching } = useQuery<StockScore[]>({
    queryKey: ["fundamentals", "rankings", "guide"],
    queryFn: async () => {
      const res = await fetch("/api/fundamentals/rankings", { credentials: "include" });
      if (!res.ok) throw new Error("rankings failed");
      return res.json();
    },
    staleTime: 5 * 60_000,
  });

  const row = useMemo(() => {
    if (!ticker || !rankings) return null;
    return rankings.find((r) => r.ticker === ticker) ?? null;
  }, [ticker, rankings]);

  const weights = familyWeightsForStyle(row?.styleBucket);

  const commit = () => {
    const t = input.trim().toUpperCase();
    if (t) setTicker(t);
  };

  return (
    <div className="rounded-md border border-sky-500/25 bg-sky-500/5 p-2.5 space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-[10px] font-semibold uppercase tracking-wide text-sky-200/90">
          Try a ticker
        </span>
        <div className="relative">
          <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-3 w-3 text-white" />
          <input
            value={input}
            onChange={(e) => setInput(e.target.value.toUpperCase())}
            onKeyDown={(e) => e.key === "Enter" && commit()}
            placeholder="NVDA"
            className="h-7 w-28 pl-7 pr-2 text-[11px] font-mono rounded border border-[#d4af37]/25 bg-zinc-950 text-white placeholder:text-white focus:outline-none focus:ring-1 focus:ring-[#d4af37]/40"
          />
        </div>
        <button
          type="button"
          onClick={commit}
          className="h-7 px-2.5 text-[11px] font-semibold rounded border border-[#d4af37]/30 text-[#d4af37] hover:bg-[#d4af37]/10"
        >
          Load
        </button>
        {isFetching && <span className="text-[10px] text-white">…</span>}
      </div>

      {ticker && !row && !isFetching && (
        <p className="text-[11px] text-amber-300/80">No persisted fund score for {ticker}.</p>
      )}

      {row && (
        <div className="space-y-2">
          <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
            <span className="text-lg font-bold text-white tabular-nums">{row.totalScore.toFixed(0)}</span>
            <span className="text-[11px] text-white">total</span>
            {row.styleBucket && (
              <span className="text-[11px] font-semibold capitalize text-[#d4af37]">
                {row.styleBucket.replace(/_/g, " ")}
              </span>
            )}
            {row.peerGroupName && (
              <span className="text-[10px] text-white">
                peers: {row.peerGroupName}
                {row.peerGroupSize != null ? ` (${row.peerGroupSize})` : ""}
              </span>
            )}
          </div>
          <FamilyBars weights={weights} highlight={row.styleBucket as StyleBucket} />
          <div className="flex flex-wrap gap-x-3 gap-y-0.5 text-[10px] text-white">
            {FAM.map((f) => (
              <span key={f}>
                <span className={cn("inline-block w-1.5 h-1.5 rounded-sm mr-1 align-middle", FAM_COLOR[f])} />
                {f} {weights[f]}%
                {row.familyScores?.[f] != null && (
                  <span className="text-white font-mono ml-1">{row.familyScores[f].score.toFixed(0)}</span>
                )}
              </span>
            ))}
          </div>
          {(row.companyScore != null || row.sectorScore != null) && (
            <div className="text-[10px] text-white font-mono">
              company {row.companyScore?.toFixed(0) ?? "—"} · sector opp {row.sectorScore?.toFixed(0) ?? "—"} · blend → total
            </div>
          )}
          <PipelineStrip activeStyle={row.styleBucket} />
        </div>
      )}
    </div>
  );
}

export function FundamentalTreatmentPanel() {
  return (
    <div className="space-y-3 rounded-md border border-[#d4af37]/25 bg-zinc-950/80 p-3">
      <div className="flex flex-wrap items-end justify-between gap-2">
        <div>
          <h2 className="text-xs font-semibold text-[#d4af37]/90 uppercase tracking-wide">
            Fundamental score
          </h2>
          <p className="text-[11px] text-white mt-0.5">
            Peer-relative quality → rankings, Model List, options stockQuality. Blanks drop out (not zero).
          </p>
        </div>
        <div className="flex gap-2 text-[9px] text-white">
          {FAM.map((f) => (
            <span key={f} className="flex items-center gap-1 capitalize">
              <span className={cn("w-2 h-2 rounded-sm", FAM_COLOR[f])} />
              {f}
            </span>
          ))}
        </div>
      </div>

      <TickerWalkthrough />

      <div>
        <div className="text-[10px] font-semibold uppercase tracking-wide text-white mb-1.5">
          Engine sequence
        </div>
        <PipelineStrip />
      </div>

      <div className="grid gap-2 lg:grid-cols-2">
        <StyleTree />
        <div className="rounded-md border border-[#d4af37]/20 bg-black/40 p-2.5 space-y-2">
          <div className="text-[10px] font-semibold uppercase tracking-wide text-[#d4af37]/80">
            Family mix by style
          </div>
          {(Object.keys(STYLE_FAMILY_WEIGHTS) as StyleBucket[]).map((style) => (
            <div key={style} className="space-y-0.5">
              <div className="flex justify-between text-[10px]">
                <span className="capitalize text-white">{style.replace(/_/g, " ")}</span>
                <span className="font-mono text-white">
                  {FAM.map((f) => STYLE_FAMILY_WEIGHTS[style][f]).join("/")}
                </span>
              </div>
              <FamilyBars weights={STYLE_FAMILY_WEIGHTS[style]} />
            </div>
          ))}
        </div>
      </div>

      <details className="rounded-md border border-white/10 bg-black/30 open:pb-1">
        <summary className="cursor-pointer px-2.5 py-1.5 text-[11px] text-white hover:text-white/80">
          Metrics catalog ({ENGINE_METRICS.length}) — expand
        </summary>
        <div className="max-h-48 overflow-y-auto px-2 pb-2">
          <table className="w-full text-[10px]">
            <thead className="sticky top-0 bg-zinc-950 text-[#d4af37]/70">
              <tr>
                <th className="text-left py-1">Metric</th>
                <th className="text-left py-1">Fam</th>
                <th className="text-right py-1">W</th>
                <th className="text-left py-1 pl-2">Note</th>
              </tr>
            </thead>
            <tbody>
              {ENGINE_METRICS.map((m) => (
                <tr key={m.key} className="border-t border-white/5 text-white">
                  <td className="py-0.5 text-white/85">{m.label}</td>
                  <td className="py-0.5 capitalize">{m.family.slice(0, 3)}</td>
                  <td className="py-0.5 text-right font-mono">{m.baseIntra}</td>
                  <td className="py-0.5 pl-2 text-white">{m.treatment}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </div>
  );
}
