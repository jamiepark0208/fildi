/**
 * Visual Scorecard Guide — fundamental engine + live ticker walkthrough.
 */
import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Search } from "lucide-react";
import { cn } from "@/lib/utils";
import { DataTip } from "@/components/data-tip";
import { HoverCard, HoverCardContent, HoverCardTrigger } from "@/components/ui/hover-card";
import {
  STYLE_FAMILY_WEIGHTS,
  ENGINE_METRICS,
  ENGINE_BY_KEY,
  CROSS_SECTION_BLEND,
  SECTOR_OPPORTUNITY_LAYER,
  type StyleBucket,
  type FamilyName,
} from "@/lib/fund-score-treatments";
import { GRID_WRAP, GRID_HEADER, GRID_TH, GRID_TD, gridRow } from "@/lib/score-explain-format";
import { peerScoreColor } from "@/components/scorecard-guide/score-walkthrough-shared";

const pct = (w: number) => CROSS_SECTION_BLEND.pct(w);
const FAM: FamilyName[] = ["value", "growth", "quality", "safety"];
const FAM_COLOR: Record<FamilyName, string> = {
  value: "bg-sky-500",
  growth: "bg-emerald-500",
  quality: "bg-violet-500",
  safety: "bg-amber-500",
};
const FAM_DOT: Record<FamilyName, string> = {
  value: "bg-sky-400",
  growth: "bg-emerald-400",
  quality: "bg-violet-400",
  safety: "bg-amber-400",
};
const FAM_TEXT: Record<FamilyName, string> = {
  value: "text-sky-300",
  growth: "text-emerald-300",
  quality: "text-violet-300",
  safety: "text-amber-300",
};
const FAM_EDGE: Record<FamilyName, string> = {
  value: "border-l-sky-400",
  growth: "border-l-emerald-400",
  quality: "border-l-violet-400",
  safety: "border-l-amber-400",
};
const FAM_LABEL: Record<FamilyName, string> = {
  value: "Value",
  growth: "Growth",
  quality: "Quality",
  safety: "Safety",
};

function FamLegend() {
  return (
    <div className="flex flex-wrap gap-x-2.5 gap-y-0.5 text-[9px] text-white">
      {FAM.map((f) => (
        <span key={f} className="inline-flex items-center gap-1 capitalize">
          <span className={cn("w-1.5 h-1.5 rounded-sm", FAM_DOT[f])} />
          <span className={FAM_TEXT[f]}>{f}</span>
        </span>
      ))}
    </div>
  );
}

const PIPELINE: { id: string; title: string; short: string; tip: string }[] = [
  {
    id: "load",
    title: "Load",
    short: "Gold + peers",
    tip: "Pull gold ticker_fundamentals (LSEG/FMP/Yahoo merge) and the ticker’s peer_group. Blanks drop out of a metric — they never score as zero.",
  },
  {
    id: "rank",
    title: "Rank",
    short: `${pct(CROSS_SECTION_BLEND.peer)}/${pct(CROSS_SECTION_BLEND.sector)}/${pct(CROSS_SECTION_BLEND.universe)}`,
    tip: `Each metric is ranked vs peers (${pct(CROSS_SECTION_BLEND.peer)}%), broader sector (${pct(CROSS_SECTION_BLEND.sector)}%), and the full universe (${pct(CROSS_SECTION_BLEND.universe)}%). Peer-relative — not a DCF and not LTCMA.`,
  },
  {
    id: "style",
    title: "Style",
    short: "Gate → weights",
    tip: "First matching style gate sets family weights (V/G/Q/S) and which metrics are excluded (e.g. financials drop D/E). See Style gate panel.",
  },
  {
    id: "family",
    title: "Families",
    short: "V · G · Q · S",
    tip: "Weighted metrics roll up into Value, Growth, Quality, Safety family scores (0–100).",
  },
  {
    id: "blend",
    title: "Total",
    short: `${pct(1 - SECTOR_OPPORTUNITY_LAYER.weight)}/${pct(SECTOR_OPPORTUNITY_LAYER.weight)}`,
    tip: `Company score (${pct(1 - SECTOR_OPPORTUNITY_LAYER.weight)}%) blends with peer-group opportunity (${pct(SECTOR_OPPORTUNITY_LAYER.weight)}%: size / prospects / cheapness) → total fund score.`,
  },
];

const STYLE_GATES: { q: string; yes: string; tip: string; bucket?: StyleBucket | "growth_or_blend" }[] = [
  {
    q: "Pre-revenue / tiny + losing?",
    yes: "pre_revenue",
    bucket: "pre_revenue",
    tip: "True only if revenue is null/≤0, or revenue <$50M and net income <0. HOOD has multi-billion revenue → never matches.",
  },
  {
    q: "Bank / insurer / REIT / financial mode?",
    yes: "financial",
    bucket: "financial",
    tip: "Matches scoringMode financial|insurance|reit|financial_mixed, or peer_group id containing bank/insur/reit/financial/broker/asset_manag.",
  },
  {
    q: "Defensive peer + not expensive?",
    yes: "quality_defensive",
    bucket: "quality_defensive",
    tip: "Staples / utilities / healthcare / pharma / telecom peers that are not expensive on peer value rank.",
  },
  {
    q: "Operating but unprofitable?",
    yes: "growth / blend",
    bucket: "growth_or_blend",
    tip: "Has real revenue but NI < 0. Fast growers → growth; else blend.",
  },
  { q: "Cheap + growing (GARP)?", yes: "garp", bucket: "garp", tip: "Peer value ≥55th and growth ≥55th." },
  { q: "Cheap, slow?", yes: "value", bucket: "value", tip: "Peer value ≥60th and growth <45th." },
  { q: "Fast, expensive?", yes: "growth", bucket: "growth", tip: "Peer growth ≥60th and value <45th; else blend / quality." },
];

const STYLE_WHY: Record<StyleBucket, string> = {
  value: "Cheap vs peers — lean Value, keep Quality.",
  growth: "Expensive growers — lean Growth + Quality.",
  garp: "Cheap and growing — balanced GARP mix.",
  blend: "No extreme signal — even mix.",
  quality_defensive: "Defensive franchise — Quality + Safety.",
  pre_revenue: "Tiny / pre-profit — Growth + Safety; Value almost off.",
  financial: "Banks/fintech/REIT mode — Safety up, Growth modest (15%).",
};

type MetricContrib = {
  key: string;
  family: string;
  raw: number | null;
  peerPct: number | null;
  contrib: number;
};

type FamilyExplain = {
  family: FamilyName;
  score: number | null;
  weightPct: number;
  contribution: number | null;
  metrics?: MetricContrib[];
};

type PeerExplain = {
  ticker: string;
  totalScore: number | null;
  valueScore: number | null;
  growthScore: number | null;
  qualityScore: number | null;
  safetyScore: number | null;
  styleBucket: string | null;
  isSubject: boolean;
  rankInPeers: number;
};

type TopMetric = {
  key: string;
  family: string;
  raw: number | null;
  peerPct: number | null;
  contrib: number;
};

type FundExplain = {
  ticker: string;
  totalScore: number | null;
  companyScore: number | null;
  sectorScore: number | null;
  rank: number;
  confidence: string | null;
  styleBucket: string | null;
  peerGroup: { id: string | null; name: string | null; size: number };
  families: FamilyExplain[];
  companyFromFamilies: number | null;
  blend: { companyWeight: number; sectorWeight: number; reconstructed: number | null };
  peers: PeerExplain[];
  metrics?: MetricContrib[];
  topMetrics: TopMetric[];
  styleGate: {
    matched: string | null;
    matchedStep: number | null;
    isPreRevenue: boolean;
    isFinancialLike: boolean;
    totalRevenue: number | null;
    netIncome: number | null;
    peerGroupId: string | null;
    scoringMode: string | null;
    why: string;
  };
  assumptions: {
    model: string;
    usesLtcma: false;
    familyWeights: Record<FamilyName, number>;
    totalBlend: { company: number; sectorOpp: number };
    crossSection: { peer: number; sector: number; universe: number };
    dataSources: string;
  };
  techTotal: number | null;
};

function gateHit(matched: string | null | undefined, gateBucket: string | undefined): boolean {
  if (!matched || !gateBucket) return false;
  if (gateBucket === "growth_or_blend") return matched === "growth" || matched === "blend";
  return matched === gateBucket;
}

function FamilyWeightBar({
  weights,
  scores,
}: {
  weights: Record<FamilyName, number>;
  scores?: Partial<Record<FamilyName, number | null>>;
}) {
  return (
    <div className="flex h-3.5 w-full overflow-hidden rounded-sm border border-white/15">
      {FAM.map((f) => {
        const tip = [
          `${FAM_LABEL[f]} weight ${weights[f]}%`,
          scores?.[f] != null ? `family score ${Number(scores[f]).toFixed(0)}` : null,
          scores?.[f] != null
            ? `contribution ${((Number(scores[f]) * weights[f]) / 100).toFixed(1)} pts to company`
            : null,
        ]
          .filter(Boolean)
          .join(" · ");
        return (
          <div
            key={f}
            className="h-full min-w-0"
            style={{ width: `${weights[f]}%`, minWidth: weights[f] > 0 ? 3 : 0 }}
          >
            <DataTip tip={tip} className="block h-full w-full" side="top">
              <div className={cn(FAM_COLOR[f], "h-full w-full hover:brightness-110")} />
            </DataTip>
          </div>
        );
      })}
    </div>
  );
}

/** One compact row — not duplicated inside the ticker card. */
function PipelineStrip({ activeStyle }: { activeStyle?: string | null }) {
  return (
    <div className="flex flex-nowrap items-stretch gap-1 overflow-x-auto pb-0.5">
      {PIPELINE.map((step, i) => {
        const styleLit = step.id === "style" && !!activeStyle;
        const tip = styleLit
          ? `${step.tip} Gold = this ticker’s style (${activeStyle!.replace(/_/g, " ")}) — annotation, not a selected/editable step.`
          : step.tip;
        return (
          <div key={step.id} className="flex items-center gap-1 shrink-0">
            <DataTip tip={tip} side="bottom">
              <div
                className={cn(
                  "rounded border px-2 py-1 min-w-0 cursor-help border-[#d4af37]/20 bg-black/50",
                )}
              >
                <div className="text-[9px] font-bold uppercase tracking-wider text-[#d4af37]">
                  {i + 1}.{step.title}
                </div>
                <div className="text-[10px] text-white leading-tight whitespace-nowrap">
                  {step.short}
                  {styleLit ? (
                    <span className="text-[#d4af37] ml-1 capitalize">
                      →{activeStyle!.replace(/_/g, " ")}
                    </span>
                  ) : null}
                </div>
              </div>
            </DataTip>
            {i < PIPELINE.length - 1 && (
              <span className="text-[#d4af37]/35 text-xs shrink-0" aria-hidden>
                →
              </span>
            )}
          </div>
        );
      })}
    </div>
  );
}

function StyleTree({ matched }: { matched?: string | null }) {
  return (
    <div className="rounded-md border border-[#d4af37]/20 bg-black/40 p-2.5 space-y-1">
      <div className="flex items-baseline justify-between gap-2 mb-1">
        <div className="text-[10px] font-semibold uppercase tracking-wide text-white">
          Style gate · first match wins
        </div>
        {matched && (
          <span className="text-[10px] font-semibold capitalize text-[#d4af37]">
            this ticker → {matched.replace(/_/g, " ")}
          </span>
        )}
      </div>
      <p className="text-[10px] text-white mb-1.5">
        Catalog of gates in order. Gold row = this ticker’s match.
      </p>
      {STYLE_GATES.map((g, i) => {
        const hit = gateHit(matched, g.bucket);
        return (
          <DataTip key={g.q} tip={g.tip} side="left">
            <div
              className={cn(
                "grid grid-cols-[auto_1fr_auto] gap-x-2 items-center text-[10px] rounded px-1 py-0.5 cursor-help",
                hit && "bg-[#d4af37]/15 ring-1 ring-[#d4af37]/40",
              )}
            >
              <span className={cn("w-4", hit ? "text-[#d4af37]" : "text-white")}>
                {i + 1}
              </span>
              <span className="text-white">{g.q}</span>
              <span
                className={cn(
                  "font-medium text-right whitespace-nowrap",
                  hit ? "text-[#d4af37]" : "text-emerald-400",
                )}
              >
                {g.yes}
              </span>
            </div>
          </DataTip>
        );
      })}
    </div>
  );
}

function FamilyMixPanel({ highlight }: { highlight?: StyleBucket | null }) {
  return (
    <div className="rounded-md border border-[#d4af37]/20 bg-black/40 p-2.5 space-y-2">
      <div className="text-[10px] font-semibold uppercase tracking-wide text-white">
        Family weights by style
      </div>
      <p className="text-[10px] text-white">
        Numbers are <span className="text-[#d4af37]">V / G / Q / S</span> weight % — not
        scores. Hover a row for why that style exists.
      </p>
      <div className="flex flex-wrap gap-x-3 gap-y-0.5 text-[9px] text-white mb-1">
        {FAM.map((f) => (
          <span key={f} className="inline-flex items-center gap-1 capitalize">
            <span className={cn("w-1.5 h-1.5 rounded-sm", FAM_DOT[f])} />
            {f}
          </span>
        ))}
      </div>
      {(Object.keys(STYLE_FAMILY_WEIGHTS) as StyleBucket[]).map((style) => {
        const w = STYLE_FAMILY_WEIGHTS[style];
        const active = highlight === style;
        return (
          <DataTip key={style} tip={STYLE_WHY[style]} side="left">
            <div
              className={cn(
                "space-y-0.5 rounded px-1 py-0.5 cursor-help",
                active && "bg-[#d4af37]/10 ring-1 ring-[#d4af37]/35",
              )}
            >
              <div className="flex justify-between text-[10px] gap-2">
                <span className={cn("capitalize", active ? "text-[#d4af37] font-semibold" : "text-white")}>
                  {style.replace(/_/g, " ")}
                  {active ? " · this ticker" : ""}
                </span>
                <span className="text-white tabular-nums">
                  {FAM.map((f) => w[f]).join("/")}
                </span>
              </div>
              <div className="flex h-2.5 w-full overflow-hidden rounded-sm border border-white/10">
                {FAM.map((f) => (
                  <div key={f} className={FAM_COLOR[f]} style={{ width: `${w[f]}%` }} />
                ))}
              </div>
            </div>
          </DataTip>
        );
      })}
    </div>
  );
}

function fmtMoney(v: number | null | undefined): string {
  if (v == null) return "—";
  if (Math.abs(v) >= 1e9) return `$${(v / 1e9).toFixed(1)}B`;
  if (Math.abs(v) >= 1e6) return `$${(v / 1e6).toFixed(0)}M`;
  return `$${v.toFixed(0)}`;
}

function metricLabel(key: string): string {
  return ENGINE_BY_KEY[key]?.label ?? key;
}

function describeRaw(key: string, raw: number | null): string {
  if (raw == null) return "No reading for this metric.";
  const meta = ENGINE_BY_KEY[key];
  const label = meta?.label ?? key;
  const pctVal = Math.abs(raw) <= 5 ? raw * 100 : raw;
  if (key === "netmgn") return `Net margin ${pctVal.toFixed(1)}% — about ${pctVal.toFixed(0)}¢ of every $1 of revenue is net income.`;
  if (key === "grossmgn") return `Gross margin ${pctVal.toFixed(1)}% — share of revenue left after cost of goods.`;
  if (key === "operatingmgn") return `Operating margin ${pctVal.toFixed(1)}% — share of revenue left after operating costs.`;
  if (key === "fcfmgn") return `FCF margin ${pctVal.toFixed(1)}% — free cash flow as % of revenue.`;
  if (key === "roe") return `ROE ${pctVal.toFixed(1)}% — net income / equity.`;
  if (key === "fcfYield" || key === "earningsYield" || key === "divy") {
    return `${label} ${pctVal.toFixed(1)}% — cash/earnings/div return vs market cap.`;
  }
  if (["revgrow", "revaccel", "epsgrow", "upside", "dilution", "netCashAssets", "gpa", "accruals", "beta", "roicwacc"].includes(key)) {
    return `${label} is ${pctVal.toFixed(1)}%.`;
  }
  if (["fwdpe", "peg", "ps", "pb", "ptbv", "evEbitda", "evRev", "pFfo"].includes(key)) {
    return `${label} multiple is ${raw.toFixed(2)}×.`;
  }
  return `${label} = ${raw.toFixed(2)}.`;
}

function describePeerPct(key: string, peerPct: number | null): string {
  if (peerPct == null) return "No peer percentile yet.";
  const meta = ENGINE_BY_KEY[key];
  const better = meta?.higherIsBetter !== false;
  if (better) {
    return `Peer% ${peerPct}: better than ${peerPct}% of tickers in this peer group on ${meta?.label ?? key} (higher is better).`;
  }
  return `Peer% ${peerPct}: cheaper/lower than ${peerPct}% of peers on ${meta?.label ?? key} (lower is better for this metric).`;
}

/** Reliable hover panel — HoverCard + scrollable compact metric grid. */
function FamilyMetricCard({
  f,
  style,
}: {
  f: FamilyExplain;
  style: string | null | undefined;
}) {
  const mets = f.metrics ?? [];
  const sum = mets.reduce((s, m) => s + m.contrib, 0);
  const drivers = [...mets].sort((a, b) => Math.abs(b.contrib) - Math.abs(a.contrib));
  return (
    <HoverCard openDelay={80} closeDelay={160}>
      <HoverCardTrigger asChild>
        <button
          type="button"
          className={cn(
            "w-full text-left rounded-sm border border-white/10 bg-zinc-950 px-2.5 py-2.5 border-l-[3px]",
            "hover:border-[#d4af37]/35 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[#d4af37]/50",
            FAM_EDGE[f.family],
          )}
        >
          <div className="flex items-center justify-between gap-1">
            <span className={cn("text-[12px] font-bold uppercase tracking-wide", FAM_TEXT[f.family])}>
              {f.family}
            </span>
            <span className="text-[11px] tabular-nums text-white">wt {f.weightPct}%</span>
          </div>
          <div className="mt-1 flex items-baseline justify-between gap-2">
            <span className={cn("text-2xl font-bold tabular-nums leading-none", peerScoreColor(f.score))}>
              {f.score != null ? f.score.toFixed(0) : "—"}
            </span>
            <div className="text-right shrink-0">
              <span className="text-sm font-semibold tabular-nums text-[#d4af37]">
                {f.contribution != null ? f.contribution.toFixed(1) : "—"}
              </span>
              <span className="text-[11px] text-white ml-0.5">to total</span>
            </div>
          </div>
          {drivers.length > 0 ? (
            <div className="mt-1.5 space-y-1 border-t border-white/15 pt-1.5">
              {drivers.map((m) => (
                <div
                  key={m.key}
                  className="flex items-center justify-between gap-1 text-[11px] leading-snug"
                  title={
                    m.peerPct != null
                      ? `${metricLabel(m.key)}: better than ${m.peerPct}% of peers → +${m.contrib.toFixed(2)} pts`
                      : undefined
                  }
                >
                  <span className="truncate text-white">{metricLabel(m.key)}</span>
                  <span className="shrink-0 tabular-nums text-white">
                    {m.peerPct != null ? (
                      <>
                        <span className="text-sky-300">{m.peerPct}% peers</span>
                        <span className="text-[#d4af37] ml-1">+{m.contrib.toFixed(1)}</span>
                      </>
                    ) : (
                      <span className="text-[#d4af37]">+{m.contrib.toFixed(1)}</span>
                    )}
                  </span>
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
        className="z-[120] w-[min(24rem,calc(100vw-1.5rem))] max-h-[min(70vh,28rem)] overflow-y-auto overscroll-contain p-0 bg-zinc-950 border border-[#d4af37]/35 text-white shadow-xl shadow-black/50"
      >
        <div className="sticky top-0 z-20 bg-zinc-950 px-2 py-1.5 border-b border-[#d4af37]/25 flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
          <span className={cn("text-[10px] font-bold uppercase", FAM_TEXT[f.family])}>
            {FAM_LABEL[f.family]}
          </span>
          <span className="text-[10px] tabular-nums text-white">
            {f.score?.toFixed(1) ?? "—"} × {f.weightPct}% ={" "}
            <span className="text-[#d4af37]">{f.contribution?.toFixed(2) ?? "—"}</span>
          </span>
          <span className="text-[9px] text-white capitalize">
            style {style?.replace(/_/g, " ") ?? "—"}
          </span>
        </div>
        {mets.length === 0 ? (
          <p className="px-2 py-2 text-[10px] text-amber-200">No metric detail yet.</p>
        ) : (
          <table className="w-full border-collapse">
            <thead className="sticky top-[2.15rem] z-10">
              <tr className={GRID_HEADER}>
                <th className={cn(GRID_TH, "text-left py-0.5 px-1.5 text-[9px]")}>Metric</th>
                <th className={cn(GRID_TH, "text-right py-0.5 px-1.5 text-[9px]")}>Raw</th>
                <th className={cn(GRID_TH, "text-right py-0.5 px-1.5 text-[9px]")}>Peer%</th>
                <th className={cn(GRID_TH, "text-right py-0.5 px-1.5 text-[9px]")}>Pts</th>
              </tr>
            </thead>
            <tbody>
              {mets.map((m, i) => {
                const tip = `${describeRaw(m.key, m.raw)}. ${describePeerPct(m.key, m.peerPct)}. Contributes ${m.contrib.toFixed(2)} pts to this family.`;
                return (
                  <tr key={m.key} className={gridRow(i)} title={tip}>
                    <td className={cn(GRID_TD, "py-0.5 px-1.5 text-[10px] text-white whitespace-nowrap")}>
                      {metricLabel(m.key)}
                    </td>
                    <td className={cn(GRID_TD, "py-0.5 px-1.5 text-[10px] text-right tabular-nums text-white")}>
                      {m.raw != null ? m.raw.toFixed(2) : "—"}
                    </td>
                    <td className={cn(GRID_TD, "py-0.5 px-1.5 text-[10px] text-right tabular-nums text-white")}>
                      {m.peerPct != null ? m.peerPct : "—"}
                    </td>
                    <td className={cn(GRID_TD, "py-0.5 px-1.5 text-[10px] text-right tabular-nums text-[#d4af37]")}>
                      {m.contrib.toFixed(2)}
                    </td>
                  </tr>
                );
              })}
              <tr className="border-t border-[#d4af37]/30 bg-black/60 sticky bottom-0">
                <td className={cn(GRID_TD, "py-0.5 px-1.5 text-[10px] text-white font-semibold")} colSpan={3}>
                  Σ → family pts
                </td>
                <td className={cn(GRID_TD, "py-0.5 px-1.5 text-[10px] text-right tabular-nums text-[#d4af37] font-semibold")}>
                  {sum.toFixed(2)}
                </td>
              </tr>
            </tbody>
          </table>
        )}
      </HoverCardContent>
    </HoverCard>
  );
}

/** One card: this ticker’s style → family weights. Replaces duplicated gate/pipeline/mix panels. */
function ThisTickerStyle({
  ticker,
  gate,
  styleBucket,
}: {
  ticker: string;
  gate: FundExplain["styleGate"];
  styleBucket: string | null;
}) {
  const style = (styleBucket && styleBucket in STYLE_FAMILY_WEIGHTS
    ? styleBucket
    : gate.matched) as StyleBucket | null;
  const w = style && style in STYLE_FAMILY_WEIGHTS ? STYLE_FAMILY_WEIGHTS[style] : null;
  const weightStr = w ? `${w.value}/${w.growth}/${w.quality}/${w.safety}` : "—";

  const pathLabel =
    gate.matched === "financial"
      ? `Pre-rev skipped → Financial matched (${gate.scoringMode ?? "financial"})`
      : gate.matched === "pre_revenue"
        ? "Pre-revenue matched"
        : gate.matched
          ? `Matched ${gate.matched.replace(/_/g, " ")} (step ${gate.matchedStep ?? "—"})`
          : "No style match";

  return (
    <div className="rounded-sm border border-[#d4af37]/25 bg-black/50 px-2.5 py-2 space-y-1.5">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5">
        <div className="text-[9px] font-semibold uppercase tracking-[0.12em] text-[#d4af37]">
          Style for {ticker}
        </div>
        <span className="text-[11px] font-semibold capitalize text-[#d4af37]">
          {style?.replace(/_/g, " ") ?? "—"}
        </span>
      </div>
      <p className="text-[11px] text-white leading-snug">
        Style picks how much Value / Growth / Quality / Safety each count toward the company
        score. First matching gate wins.
      </p>
      <p className="text-[10px] text-white">
        <span className="text-[#d4af37]">Path · </span>
        {pathLabel}
        <span className="text-white"> · </span>
        rev {fmtMoney(gate.totalRevenue)}
        <span className="text-white"> · </span>
        NI {fmtMoney(gate.netIncome)}
      </p>
      {w && (
        <div className="space-y-1">
          <div className="flex items-center justify-between gap-2 text-[10px]">
            <span className="text-white">Family weights (not scores)</span>
            <span className="tabular-nums text-[#d4af37]">
              V/G/Q/S {weightStr}
            </span>
          </div>
          <div className="flex h-3 w-full overflow-hidden rounded-sm border border-white/10">
            {FAM.map((f) => (
              <DataTip key={f} tip={`${FAM_LABEL[f]} ${w[f]}% of company score`} className="h-full" side="top">
                <div className={cn(FAM_COLOR[f], "h-full")} style={{ width: `${w[f]}%` }} />
              </DataTip>
            ))}
          </div>
          <FamLegend />
          {style === "financial" && (
            <p className="text-[10px] text-emerald-300">
              Growth weight 15% = how much the growth family counts — not the growth family score
              itself.
            </p>
          )}
        </div>
      )}
    </div>
  );
}

/** Ticker search — lives on the Fundamental/Technical/Options tab row. */
export function FundWalkthroughControls({
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

function TickerWalkthrough({
  ticker,
  onStyle,
}: {
  ticker: string;
  onStyle: (s: StyleBucket | null) => void;
}) {
  const { data: explain, error } = useQuery<FundExplain>({
    queryKey: ["fundamentals", "explain", ticker],
    queryFn: async () => {
      const res = await fetch(`/api/fundamentals/explain/${encodeURIComponent(ticker)}`, {
        credentials: "include",
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error ?? "explain failed");
      }
      return res.json();
    },
    enabled: !!ticker,
    staleTime: 5 * 60_000,
  });

  useEffect(() => {
    if (explain?.styleBucket && explain.styleBucket in STYLE_FAMILY_WEIGHTS) {
      onStyle(explain.styleBucket as StyleBucket);
    }
  }, [explain?.styleBucket, onStyle]);

  const weightMap = useMemo(() => {
    const m = {} as Record<FamilyName, number>;
    for (const f of FAM) m[f] = explain?.families.find((r) => r.family === f)?.weightPct ?? 0;
    return m;
  }, [explain]);

  const scoreMap = useMemo(() => {
    const m = {} as Record<FamilyName, number | null>;
    for (const f of FAM) m[f] = explain?.families.find((r) => r.family === f)?.score ?? null;
    return m;
  }, [explain]);

  const [famFilter, setFamFilter] = useState<FamilyName | "all">("all");
  const td = "py-0.5 px-1 text-[10px] tabular-nums whitespace-nowrap";
  const th = "py-0.5 px-1 font-semibold text-[9px] uppercase tracking-wide text-[#d4af37] whitespace-nowrap";
  const metricRows = explain?.metrics?.length
    ? explain.metrics
    : (explain?.topMetrics ?? []).map((m) => ({
        key: m.key,
        family: m.family,
        raw: m.raw,
        peerPct: m.peerPct,
        contrib: m.contrib,
      }));
  const filteredMetrics =
    famFilter === "all"
      ? metricRows
      : metricRows.filter((m) => m.family === famFilter);
  const peersUsed = explain?.peers.filter((p) => p.totalScore != null).length ?? 0;
  /** Dead/renamed symbols that somehow still appear (should be rare after quarantine sweep). */
  const peersDead = explain?.peers.filter(
    (p) =>
      !p.isSubject &&
      (p.totalScore == null || p.styleBucket === "pre_revenue") &&
      ["SQ", "ADYEN", "DFS", "MMC", "BK", "PSTG", "PEAK", "CHX"].includes(p.ticker),
  ) ?? [];

  return (
    <div className="space-y-2">
      {error && (
        <p className="text-[11px] text-amber-300">
          {(error as Error).message || `No fund score for ${ticker}.`}
        </p>
      )}

      {explain && (
        <>
          <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 border-b border-[#d4af37]/15 pb-1.5 text-[11px]">
            <DataTip
              tip={`Total = ${pct(1 - SECTOR_OPPORTUNITY_LAYER.weight)}% company + ${pct(SECTOR_OPPORTUNITY_LAYER.weight)}% peer-group opportunity. Metric ranks (55/30/15) are a different step.`}
            >
              <div className="flex items-baseline gap-1.5 cursor-help">
                <span className="text-xl font-semibold tabular-nums leading-none text-white">
                  {explain.totalScore != null ? explain.totalScore.toFixed(0) : "—"}
                </span>
                <span className="text-[9px] font-semibold uppercase tracking-wide text-[#d4af37]">
                  total
                </span>
              </div>
            </DataTip>
            <DataTip tip="Style bucket from first matching gate — sets V/G/Q/S weights.">
              <span className="text-[12px] font-semibold capitalize text-[#f0d78c] cursor-help">
                {explain.styleBucket?.replace(/_/g, " ") ?? "—"}
              </span>
            </DataTip>
            <span className="text-white">
              {explain.peerGroup.name ?? "—"}
              <span className="text-white"> · {explain.peerGroup.size} peers</span>
            </span>
            {explain.rank > 0 && (
              <DataTip tip="Universe fund rank among all scored tickers (1 = best total). Not peer-group rank.">
                <span className="tabular-nums text-white cursor-help">
                  univ rank #{explain.rank}
                </span>
              </DataTip>
            )}
            <DataTip tip="Company = Σ (family score × style weight). Built before the opportunity blend.">
              <span className="tabular-nums text-sky-400 cursor-help">
                company{" "}
                <span className="font-semibold text-sky-300">
                  {explain.companyScore?.toFixed(0) ?? "—"}
                </span>
              </span>
            </DataTip>
            <DataTip tip="Opportunity (opp) = how attractive this peer group looks on size / growth / cheapness. Blended into total at 10% — not GICS sector label.">
              <span className="tabular-nums text-violet-400 cursor-help">
                opportunity{" "}
                <span className="font-semibold text-violet-300">
                  {explain.sectorScore?.toFixed(0) ?? "—"}
                </span>
              </span>
            </DataTip>
            {explain.techTotal != null && (
              <DataTip tip="Separate technical scorecard total — not part of the fund total.">
                <span className="tabular-nums text-emerald-400 cursor-help">
                  technical{" "}
                  <span className="font-semibold text-emerald-300">
                    {explain.techTotal.toFixed(0)}
                  </span>
                </span>
              </DataTip>
            )}
          </div>

          <div className="space-y-1">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="text-[10px] font-semibold uppercase tracking-wide text-white">
                How {explain.ticker} got {explain.totalScore?.toFixed(0) ?? "—"}
              </div>
              <FamLegend />
            </div>
            <FamilyWeightBar weights={weightMap} scores={scoreMap} />
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-1.5">
              {explain.families.map((f) => (
                <FamilyMetricCard key={f.family} f={f} style={explain.styleBucket} />
              ))}
            </div>
            <DataTip
              tip={`Company = Σ family×weight. Total then mixes in peer-group opportunity (${pct(SECTOR_OPPORTUNITY_LAYER.weight)}%). Separate from metric cross-section ${pct(CROSS_SECTION_BLEND.peer)}/${pct(CROSS_SECTION_BLEND.sector)}/${pct(CROSS_SECTION_BLEND.universe)}.`}
            >
              <p className="text-[10px] text-white cursor-help">
                families{" "}
                <span className="font-semibold tabular-nums text-[#f0d78c]">
                  {explain.companyFromFamilies?.toFixed(1) ?? "—"}
                </span>
                <span className="text-white"> → </span>
                total{" "}
                <span className="font-semibold tabular-nums text-[#f0d78c]">
                  {explain.blend.reconstructed?.toFixed(1) ?? "—"}
                </span>
                {explain.styleBucket === "financial" && (
                  <span className="text-emerald-400">
                    {" · "}growth weight {scoreMap.growth != null ? "15%" : "—"} · score{" "}
                    <span className="font-semibold tabular-nums text-emerald-300">
                      {scoreMap.growth?.toFixed(0) ?? "—"}
                    </span>
                  </span>
                )}
              </p>
            </DataTip>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-2 items-start">
            <div className="min-w-0">
              <div className="text-[10px] font-semibold uppercase tracking-wide text-white mb-0.5">
                Peers · {explain.peerGroup.name ?? "group"} ({explain.peers.length})
                <span className="ml-1.5 font-normal normal-case tracking-normal text-white">
                  · {peersUsed}/{explain.peers.length} used in ranks
                </span>
              </div>
              <div className={cn(GRID_WRAP, "max-h-48")}>
                <table className="w-full border-collapse">
                  <thead className="sticky top-0 z-10">
                    <tr className={GRID_HEADER}>
                      <th className={cn(th, "text-left")}>#</th>
                      <th className={cn(th, "text-left")}>Tkr</th>
                      <th className={cn(th, "text-center")}>Used</th>
                      <th className={cn(th, "text-right")}>Tot</th>
                      <th className={cn(th, "text-right")}>V</th>
                      <th className={cn(th, "text-right")}>G</th>
                      <th className={cn(th, "text-right")}>Q</th>
                      <th className={cn(th, "text-right")}>S</th>
                      <th className={cn(th, "text-left")}>Style</th>
                    </tr>
                  </thead>
                  <tbody>
                    {explain.peers.map((p, i) => {
                      const used = p.totalScore != null;
                      return (
                        <tr
                          key={p.ticker}
                          className={cn(
                            gridRow(i),
                            p.isSubject && "bg-[#d4af37]/10 ring-1 ring-inset ring-[#d4af37]/35",
                          )}
                        >
                          <td className={cn(td, "text-white")}>{used ? p.rankInPeers : "—"}</td>
                          <td className={cn(td, "font-semibold text-white")}>{p.ticker}</td>
                          <td className={cn(td, "text-center")}>
                            <DataTip
                              tip={
                                used
                                  ? "Has a fund total — included in peer ranks / relative view."
                                  : "No fund total — not used in ranked peer comparison."
                              }
                            >
                              <span
                                className={cn(
                                  "cursor-help text-[9px] font-semibold uppercase",
                                  used ? "text-emerald-300" : "text-amber-300",
                                )}
                              >
                                {used ? "yes" : "no"}
                              </span>
                            </DataTip>
                          </td>
                          <td className={cn(td, "text-right text-white")}>
                            {p.totalScore != null ? p.totalScore.toFixed(0) : "—"}
                          </td>
                          <td className={cn(td, "text-right text-sky-300")}>
                            {p.valueScore != null ? p.valueScore.toFixed(0) : "—"}
                          </td>
                          <td className={cn(td, "text-right text-emerald-300")}>
                            {p.growthScore != null ? p.growthScore.toFixed(0) : "—"}
                          </td>
                          <td className={cn(td, "text-right text-violet-300")}>
                            {p.qualityScore != null ? p.qualityScore.toFixed(0) : "—"}
                          </td>
                          <td className={cn(td, "text-right text-amber-300")}>
                            {p.safetyScore != null ? p.safetyScore.toFixed(0) : "—"}
                          </td>
                          <td className={cn(td, "capitalize text-white")}>
                            {(p.styleBucket ?? "—").replace(/_/g, " ")}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              {peersDead.length > 0 && (
                <p className="mt-0.5 text-[9px] text-amber-200">
                  {peersDead.map((p) => p.ticker).join(", ")}: delisted/renamed leftovers (e.g. SQ→XYZ,
                  ADYEN not in US book). Soft-removed from peer roster — reload walkthrough.
                </p>
              )}
            </div>

            <div className="min-w-0">
              <div className="flex flex-wrap items-center justify-between gap-1 mb-0.5">
                <div className="text-[10px] font-semibold uppercase tracking-wide text-white">
                  Metric drivers · {explain.ticker}
                </div>
                <div className="flex flex-wrap gap-0.5">
                  {(["all", ...FAM] as const).map((f) => (
                    <button
                      key={f}
                      type="button"
                      onClick={() => setFamFilter(f)}
                      className={cn(
                        "px-1.5 py-0.5 text-[9px] font-semibold uppercase rounded border",
                        famFilter === f
                          ? "border-[#d4af37]/50 bg-[#d4af37]/15 text-[#d4af37]"
                          : "border-white/15 text-white hover:border-[#d4af37]/30",
                        f !== "all" && FAM_TEXT[f],
                      )}
                    >
                      {f === "all" ? "All" : FAM_LABEL[f]}
                    </button>
                  ))}
                </div>
              </div>
              {filteredMetrics.length === 0 ? (
                <p className="text-[10px] text-amber-200">No metric contribs yet.</p>
              ) : (
                <div className={cn(GRID_WRAP, "max-h-48")}>
                  <table className="w-full border-collapse">
                    <thead className="sticky top-0 z-10">
                      <tr className={GRID_HEADER}>
                        <th className={cn(th, "text-left")}>Metric</th>
                        <th className={cn(th, "text-left")}>Fam</th>
                        <th className={cn(th, "text-right")}>Raw</th>
                        <th className={cn(th, "text-right")}>Peer%</th>
                        <th className={cn(th, "text-right")}>Pts</th>
                      </tr>
                    </thead>
                    <tbody>
                      {filteredMetrics.slice(0, 24).map((m, i) => {
                        const meta = ENGINE_BY_KEY[m.key];
                        const engTip = [
                          meta?.label ?? m.key,
                          meta ? `Source: ${meta.goldInputs}` : null,
                          meta ? `Treatment: ${meta.treatment}` : null,
                        ]
                          .filter(Boolean)
                          .join("\n");
                        const rawTip = describeRaw(m.key, m.raw);
                        const peerTip = describePeerPct(m.key, m.peerPct);
                        return (
                          <tr key={m.key} className={gridRow(i)}>
                            <td className={cn(td, "text-white")}>
                              <DataTip tip={engTip}>{metricLabel(m.key)}</DataTip>
                            </td>
                            <td className={cn(td, "capitalize text-white")}>{m.family}</td>
                            <td className={cn(td, "text-right text-white")}>
                              <DataTip tip={rawTip}>
                                <span className="cursor-help">
                                  {m.raw != null ? m.raw.toFixed(2) : "—"}
                                </span>
                              </DataTip>
                            </td>
                            <td className={cn(td, "text-right text-white")}>
                              <DataTip tip={peerTip}>
                                <span className="cursor-help">
                                  {m.peerPct != null ? m.peerPct : "—"}
                                </span>
                              </DataTip>
                            </td>
                            <td className={cn(td, "text-right text-[#d4af37]")}>
                              <DataTip tip={`Adds ${m.contrib.toFixed(2)} pts toward company score.`}>
                                <span className="cursor-help">{m.contrib.toFixed(2)}</span>
                              </DataTip>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </div>

          <ThisTickerStyle
            ticker={explain.ticker}
            gate={explain.styleGate}
            styleBucket={explain.styleBucket}
          />
        </>
      )}
    </div>
  );
}

export function FundamentalTreatmentPanel({
  ticker = "HOOD",
}: {
  ticker?: string;
}) {
  const [walkStyle, setWalkStyle] = useState<StyleBucket | null>(null);

  return (
    <div className="space-y-2.5">
      {/* Live ticker story: score → families → peers/metrics → style weights. One place. */}
      <TickerWalkthrough ticker={ticker} onStyle={setWalkStyle} />

      <details className="rounded-sm border border-white/10 bg-black/30">
        <summary className="cursor-pointer px-2.5 py-1.5 text-[11px] text-white hover:text-[#d4af37]">
          How the fund engine works (5 steps)
        </summary>
        <div className="px-2.5 pb-2 space-y-1.5">
          <p className="text-[10px] text-white leading-snug">
            Load gold fundamentals + peers → rank each metric vs peers/sector/universe → pick
            style (sets V/G/Q/S weights) → roll up families → blend company with peer-group
            opportunity into total.
          </p>
          <PipelineStrip activeStyle={walkStyle} />
        </div>
      </details>

      <details className="rounded-sm border border-white/10 bg-black/30">
        <summary className="cursor-pointer px-2.5 py-1.5 text-[11px] text-white hover:text-[#d4af37]">
          Style reference — all gates & weight mixes
        </summary>
        <div className="grid gap-2 md:grid-cols-2 px-2 pb-2 pt-1">
          <StyleTree matched={walkStyle} />
          <FamilyMixPanel highlight={walkStyle} />
        </div>
      </details>

      <details className="rounded-sm border border-white/10 bg-black/30">
        <summary className="cursor-pointer px-2.5 py-1.5 text-[11px] text-white hover:text-[#d4af37]">
          Metrics catalog ({ENGINE_METRICS.length})
        </summary>
        <div className="max-h-48 overflow-y-auto px-2 pb-2">
          <table className="w-full text-[10px]">
            <thead className="sticky top-0 bg-zinc-950 text-[#d4af37]">
              <tr>
                <th className="text-left py-1">Metric</th>
                <th className="text-left py-1">Fam</th>
                <th className="text-right py-1">W</th>
                <th className="text-left py-1 pl-2">Source</th>
              </tr>
            </thead>
            <tbody>
              {ENGINE_METRICS.map((m) => (
                <tr key={m.key} className="border-t border-white/10 text-white">
                  <td className="py-0.5 text-white">{m.label}</td>
                  <td className="py-0.5 capitalize">{m.family.slice(0, 3)}</td>
                  <td className="py-0.5 text-right">{m.baseIntra}</td>
                  <td className="py-0.5 pl-2 text-white">{m.goldInputs}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </div>
  );
}
