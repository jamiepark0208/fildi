/**
 * Shared chrome for Scorecard Guide walkthroughs (fund / tech / options).
 * Same visual language: total → component cards with top drivers → detail tables.
 * No grey body text — white / gold / accent only.
 */
import { Search } from "lucide-react";
import { cn } from "@/lib/utils";
import { DataTip } from "@/components/data-tip";
import { HoverCard, HoverCardContent, HoverCardTrigger } from "@/components/ui/hover-card";
import { GRID_WRAP, GRID_HEADER, GRID_TH, GRID_TD, gridRow } from "@/lib/score-explain-format";

export type WalkDriver = {
  label: string;
  detail: string;
  tip?: string;
};

export type WalkComponent = {
  key: string;
  label: string;
  /** 0–100 family/component score (or null). */
  score: number | null;
  /** Weight as percent of total (e.g. 25). */
  weightPct: number;
  /** Points contributed toward total (score × weight/100 when score is 0–100). */
  contribution: number | null;
  /** Accent edge class e.g. border-l-sky-400 */
  edgeClass: string;
  /** Label color class */
  textClass: string;
  drivers: WalkDriver[];
  /** Optional display-only flag */
  displayOnly?: boolean;
  /** Bar segment color (ComponentWeightBar) */
  barClass?: string;
};

const EDGE_CYCLE = [
  { edge: "border-l-sky-400", text: "text-sky-300", bar: "bg-sky-500" },
  { edge: "border-l-emerald-400", text: "text-emerald-300", bar: "bg-emerald-500" },
  { edge: "border-l-violet-400", text: "text-violet-300", bar: "bg-violet-500" },
  { edge: "border-l-amber-400", text: "text-amber-300", bar: "bg-amber-500" },
  { edge: "border-l-rose-400", text: "text-rose-300", bar: "bg-rose-500" },
  { edge: "border-l-cyan-400", text: "text-cyan-300", bar: "bg-cyan-500" },
] as const;

export function walkAccent(i: number) {
  return EDGE_CYCLE[i % EDGE_CYCLE.length]!;
}

/** Horizontal weight strip — same visual language as fund FamilyWeightBar. */
export function ComponentWeightBar({
  components,
}: {
  components: Array<{
    key: string;
    label: string;
    weightPct: number;
    score: number | null;
    contribution: number | null;
    barClass: string;
  }>;
}) {
  const weighted = components.filter((c) => c.weightPct > 0);
  if (!weighted.length) return null;
  return (
    <div className="flex h-3.5 w-full overflow-hidden rounded-sm border border-white/15">
      {weighted.map((c) => {
        const tip = [
          `${c.label} weight ${c.weightPct}%`,
          c.score != null ? `component ${c.score.toFixed(0)}` : null,
          c.contribution != null ? `${c.contribution.toFixed(1)} pts to total` : null,
        ]
          .filter(Boolean)
          .join(" · ");
        return (
          <div
            key={c.key}
            className="h-full min-w-0"
            style={{ width: `${c.weightPct}%`, minWidth: c.weightPct > 0 ? 3 : 0 }}
          >
            <DataTip tip={tip} className="block h-full w-full" side="top">
              <div className={cn(c.barClass, "h-full w-full hover:brightness-110")} />
            </DataTip>
          </div>
        );
      })}
    </div>
  );
}

export function WalkthroughControls({
  input,
  onInput,
  onLoad,
  loading,
}: {
  input: string;
  onInput: (v: string) => void;
  onLoad: () => void;
  loading?: boolean;
}) {
  return (
    <div className="flex items-center gap-1.5 ml-auto">
      <span className="text-[10px] font-semibold uppercase tracking-[0.14em] text-[#d4af37] whitespace-nowrap">
        Live walkthrough
      </span>
      <div className="relative">
        <Search className="absolute left-1.5 top-1/2 -translate-y-1/2 h-3 w-3 text-white" />
        <input
          value={input}
          onChange={(e) => onInput(e.target.value.toUpperCase())}
          onKeyDown={(e) => e.key === "Enter" && onLoad()}
          placeholder="HOOD"
          className="h-6 w-24 pl-6 pr-1.5 text-[11px] font-mono rounded border border-[#d4af37]/30 bg-zinc-950 text-white placeholder:text-amber-100/70 focus:outline-none focus:ring-1 focus:ring-[#d4af37]/40"
        />
      </div>
      <button
        type="button"
        onClick={onLoad}
        className="h-6 px-2 text-[11px] font-semibold rounded border border-[#d4af37]/40 text-[#d4af37] hover:bg-[#d4af37]/10"
      >
        Load
      </button>
      {loading && <span className="text-[10px] text-white">…</span>}
    </div>
  );
}

/** Family/component score 0–100 is peer-relative → R/Y/G text. */
export function peerScoreColor(score: number | null | undefined): string {
  if (score == null || !Number.isFinite(score)) return "text-white";
  if (score >= 70) return "text-emerald-400";
  if (score >= 50) return "text-amber-300";
  return "text-red-400";
}

export function ComponentMetricCard({ c }: { c: WalkComponent }) {
  return (
    <HoverCard openDelay={80} closeDelay={160}>
      <HoverCardTrigger asChild>
        <button
          type="button"
          className={cn(
            "w-full text-left rounded-sm border border-white/10 bg-zinc-950 px-2.5 py-2.5 border-l-[3px]",
            "hover:border-[#d4af37]/35 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[#d4af37]/50",
            c.edgeClass,
            c.displayOnly && "opacity-80",
          )}
        >
          <div className="flex items-center justify-between gap-1">
            <span className={cn("text-[12px] font-bold uppercase tracking-wide", c.textClass)}>
              {c.label}
            </span>
            <span
              className="text-[11px] tabular-nums text-white"
              title={c.displayOnly ? "Context only — not in total (S042 / A155)" : undefined}
            >
              {c.displayOnly ? "context" : `wt ${c.weightPct}%`}
            </span>
          </div>
          <div className="mt-1 flex items-baseline justify-between gap-2">
            <span className={cn("text-2xl font-bold tabular-nums leading-none", peerScoreColor(c.score))}>
              {c.score != null ? c.score.toFixed(0) : "—"}
            </span>
            {!c.displayOnly && (
              <div className="text-right shrink-0">
                <span className="text-sm font-semibold tabular-nums text-[#d4af37]">
                  {c.contribution != null ? c.contribution.toFixed(1) : "—"}
                </span>
                <span className="text-[11px] text-white ml-0.5">to total</span>
              </div>
            )}
          </div>
          {c.drivers.length > 0 ? (
            <div className="mt-1.5 space-y-1 border-t border-white/15 pt-1.5">
              {c.drivers.map((d) => (
                <div
                  key={d.label}
                  className="flex items-center justify-between gap-1 text-[11px] leading-snug"
                  title={d.tip ?? `${d.label}: ${d.detail}`}
                >
                  <span className="truncate text-white">{d.label}</span>
                  <span className="shrink-0 tabular-nums text-sky-300">{d.detail}</span>
                </div>
              ))}
            </div>
          ) : null}
        </button>
      </HoverCardTrigger>
      <HoverCardContent
        side="bottom"
        align="start"
        sideOffset={6}
        collisionPadding={16}
        className="z-[120] w-[min(22rem,calc(100vw-1.5rem))] max-h-[min(60vh,24rem)] overflow-y-auto overscroll-contain p-0 bg-zinc-950 border border-[#d4af37]/35 text-white shadow-xl shadow-black/50"
      >
        <div className="sticky top-0 z-20 bg-zinc-950 px-2 py-1.5 border-b border-[#d4af37]/25">
          <span className={cn("text-[10px] font-bold uppercase", c.textClass)}>{c.label}</span>
          <span className="ml-2 text-[10px] tabular-nums text-white">
            {c.score?.toFixed(1) ?? "—"}
            {!c.displayOnly && (
              <>
                {" "}
                × {c.weightPct}% ={" "}
                <span className="text-[#d4af37]">{c.contribution?.toFixed(2) ?? "—"}</span>
              </>
            )}
          </span>
        </div>
        {c.drivers.length === 0 ? (
          <p className="px-2 py-2 text-[10px] text-amber-200">No sub-metric detail.</p>
        ) : (
          <table className="w-full border-collapse">
            <thead>
              <tr className={GRID_HEADER}>
                <th className={cn(GRID_TH, "text-left py-0.5 px-1.5 text-[9px]")}>Input</th>
                <th className={cn(GRID_TH, "text-right py-0.5 px-1.5 text-[9px]")}>Reading</th>
              </tr>
            </thead>
            <tbody>
              {c.drivers.map((d, i) => (
                <tr key={d.label} className={gridRow(i)} title={d.tip}>
                  <td className={cn(GRID_TD, "py-0.5 px-1.5 text-[10px] text-white")}>{d.label}</td>
                  <td className={cn(GRID_TD, "py-0.5 px-1.5 text-[10px] text-right tabular-nums text-sky-300")}>
                    {d.detail}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </HoverCardContent>
    </HoverCard>
  );
}

export function WalkScoreHeader({
  total,
  title,
  chips,
}: {
  total: number | null;
  title: string;
  chips: Array<{ label: string; value: string; tip?: string; className?: string }>;
}) {
  return (
    <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 border-b border-[#d4af37]/15 pb-1.5 text-[11px]">
      <DataTip tip={title}>
        <div className="flex items-baseline gap-1.5 cursor-help">
          <span className="text-xl font-semibold tabular-nums leading-none text-white">
            {total != null ? total.toFixed(0) : "—"}
          </span>
          <span className="text-[9px] font-semibold uppercase tracking-wide text-[#d4af37]">total</span>
        </div>
      </DataTip>
      {chips.map((c) => {
        const body = (
          <span className={cn("tabular-nums text-white", c.className)}>
            {c.label}{" "}
            <span className="font-semibold">{c.value}</span>
          </span>
        );
        return c.tip ? (
          <DataTip key={c.label} tip={c.tip}>
            <span className="cursor-help">{body}</span>
          </DataTip>
        ) : (
          <span key={c.label}>{body}</span>
        );
      })}
    </div>
  );
}

export function WalkDriversTable({
  title,
  rows,
}: {
  title: string;
  rows: Array<{ name: string; fam: string; raw: string; pts: string; tip?: string }>;
}) {
  const th =
    "py-0.5 px-1 font-semibold text-[9px] uppercase tracking-wide text-[#d4af37] whitespace-nowrap";
  const td = "py-0.5 px-1 text-[10px] tabular-nums whitespace-nowrap";
  return (
    <div className="min-w-0">
      <div className="text-[10px] font-semibold uppercase tracking-wide text-white mb-0.5">{title}</div>
      {rows.length === 0 ? (
        <p className="text-[10px] text-amber-200">No drivers yet.</p>
      ) : (
        <div className={cn(GRID_WRAP, "max-h-48")}>
          <table className="w-full border-collapse">
            <thead className="sticky top-0 z-10">
              <tr className={GRID_HEADER}>
                <th className={cn(th, "text-left")}>Metric</th>
                <th className={cn(th, "text-left")}>Comp</th>
                <th className={cn(th, "text-right")}>Reading</th>
                <th className={cn(th, "text-right")}>Pts</th>
              </tr>
            </thead>
            <tbody>
              {rows.slice(0, 24).map((r, i) => (
                <tr key={`${r.fam}-${r.name}`} className={gridRow(i)} title={r.tip}>
                  <td className={cn(td, "text-white")}>{r.name}</td>
                  <td className={cn(td, "text-white")}>{r.fam}</td>
                  <td className={cn(td, "text-right text-sky-300")}>{r.raw}</td>
                  <td className={cn(td, "text-right text-[#d4af37]")}>{r.pts}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
