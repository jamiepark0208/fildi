/**
 * Breakdown › Street — plain-English lean + compact GRID metrics (hover = implication).
 * Soft evidence only; does not change fund score.
 */
import { useState } from "react";
import { cn } from "@/lib/utils";
import { WrdsStreetPanel } from "./wrds-street-panel";
import { LsegStreetPanel } from "./lseg-street-panel";
import { GRID_WRAP, GRID_HEADER, GRID_TH, GRID_TD, gridRow } from "@/lib/score-explain-format";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

export type StreetSynthesisData = {
  ticker: string;
  tone: "supportive" | "neutral" | "caution";
  level: {
    summary: string | null;
    yahooBullishPct?: number | null;
    yahooTargetUpsidePct?: number | null;
    lsegRecMean?: number | null;
    lsegTargetUpsidePct?: number | null;
  };
  path: {
    summary: string | null;
    ibesBreadth?: number | null;
    ibesSue?: number | null;
    meanDriftPct?: number | null;
    epsDrift30dPct?: number | null;
    predSurprisePct?: number | null;
  };
  quality: {
    summary: string | null;
    armRank?: number | null;
    combinedAlphaRank?: number | null;
  };
  eventRisk: boolean;
  conflicts: Array<{ code: string; text: string }>;
  sources: string[];
};

const TONE_CHIP: Record<string, string> = {
  supportive: "border-emerald-400/70 text-white bg-zinc-900",
  neutral: "border-zinc-400/60 text-white bg-zinc-900",
  caution: "border-amber-400/80 text-white bg-zinc-900",
};

const TONE_LABEL: Record<string, string> = {
  supportive: "Supportive",
  neutral: "Neutral",
  caution: "Caution",
};

type Metric = { key: string; label: string; value: string; tip: string; tone?: string };

function fmtSigned(n: number, digits: number, suffix = ""): string {
  return `${n >= 0 ? "+" : ""}${n.toFixed(digits)}${suffix}`;
}

function buildMetrics(street: StreetSynthesisData): Metric[] {
  const p = street.path;
  const q = street.quality;
  const l = street.level;
  const out: Metric[] = [];

  if (p.ibesBreadth != null) {
    const v = p.ibesBreadth;
    out.push({
      key: "breadth",
      label: "Net raises",
      value: fmtSigned(v, 2),
      tip:
        v < -0.08
          ? "More analysts cutting FY1 EPS than raising — headwind."
          : v > 0.08
            ? "More analysts raising FY1 EPS than cutting — mild support."
            : "Raises ≈ cuts — no clear revision lean.",
      tone: v < -0.08 ? "text-red-300" : v > 0.08 ? "text-emerald-300" : "text-white",
    });
  }
  if (p.ibesSue != null) {
    const v = p.ibesSue;
    out.push({
      key: "sue",
      label: "Beat score",
      value: v.toFixed(2),
      tip:
        v <= -0.5
          ? "Recent earnings surprises run soft vs Street."
          : v >= 0.5
            ? "Recent earnings surprises run ahead of Street."
            : "Beat/miss streak near average.",
      tone: v <= -0.5 ? "text-red-300" : v >= 0.5 ? "text-emerald-300" : "text-white",
    });
  }
  if (p.meanDriftPct != null) {
    const v = p.meanDriftPct;
    out.push({
      key: "fy1",
      label: "FY1 drift",
      value: fmtSigned(v, 1, "%"),
      tip: "How much the FY1 EPS consensus moved recently.",
      tone: v <= -1 ? "text-red-300" : v >= 1 ? "text-emerald-300" : "text-white",
    });
  }
  if (p.epsDrift30dPct != null) {
    const v = p.epsDrift30dPct;
    out.push({
      key: "eps30",
      label: "30d EPS",
      value: fmtSigned(v, 1, "%"),
      tip: "LSEG near-term EPS estimate move over ~30 days.",
      tone: v <= -2 ? "text-red-300" : v >= 2 ? "text-emerald-300" : "text-white",
    });
  }
  if (p.predSurprisePct != null) {
    const v = p.predSurprisePct;
    out.push({
      key: "pred",
      label: "Pred. surp.",
      value: fmtSigned(v, 1, "%"),
      tip: "Model’s predicted earnings surprise — not a guarantee.",
      tone: v <= -2 ? "text-red-300" : v >= 2 ? "text-emerald-300" : "text-white",
    });
  }
  if (q.armRank != null) {
    out.push({
      key: "arm",
      label: "Est. mom.",
      value: String(q.armRank),
      tip: "ARM = estimate-momentum rank (higher = Street lifting numbers vs peers).",
      tone: "text-white",
    });
  }
  if (q.combinedAlphaRank != null) {
    out.push({
      key: "alpha",
      label: "Alpha rank",
      value: String(q.combinedAlphaRank),
      tip: "StarMine combined alpha rank vs peers (higher usually better).",
      tone: "text-white",
    });
  }
  if (l.yahooBullishPct != null) {
    const v = l.yahooBullishPct;
    out.push({
      key: "yahoo",
      label: "Yahoo buy%",
      value: `${v.toFixed(0)}%`,
      tip: "Share of Yahoo ratings that are buy/overweight — can disagree with estimate cuts.",
      tone: v >= 65 ? "text-emerald-300" : v <= 35 ? "text-red-300" : "text-white",
    });
  }
  if (l.yahooTargetUpsidePct != null) {
    const v = l.yahooTargetUpsidePct;
    out.push({
      key: "pt",
      label: "PT upside",
      value: fmtSigned(v, 0, "%"),
      tip: "Yahoo mean price target vs last price.",
      tone: v >= 10 ? "text-emerald-300" : v <= -5 ? "text-red-300" : "text-white",
    });
  }

  // Fallback if API only sent summaries (old payload)
  if (out.length === 0) {
    if (street.path.summary) {
      out.push({
        key: "path",
        label: "Revisions",
        value: street.path.summary.replace(/\bIBES\b/g, "").replace(/\bSUE\b/g, "beat").trim(),
        tip: "Estimate revisions / surprise path.",
        tone: "text-white",
      });
    }
    if (street.quality.summary) {
      out.push({
        key: "qual",
        label: "Forward",
        value: street.quality.summary.replace(/\bARM\b/g, "est. mom"),
        tip: "Forward estimate momentum / alpha ranks.",
        tone: "text-white",
      });
    }
    if (street.level.summary) {
      out.push({
        key: "lvl",
        label: "Consensus",
        value: street.level.summary,
        tip: "Wall Street rating / target lean.",
        tone: "text-white",
      });
    }
  }
  return out;
}

function soWhat(street: StreetSynthesisData): string {
  const conflict = street.conflicts[0]?.text;
  if (conflict) return conflict;
  if (street.tone === "caution") {
    return "More analysts cutting estimates than raising — treat Street as a headwind.";
  }
  if (street.tone === "supportive") {
    return "Estimate revisions lean up — Street is a mild tailwind.";
  }
  return "Street signals mixed — no clear lean either way.";
}

/** Badges for BreakdownPanel title row (right of “Street”). */
export function StreetHeaderBadges({ street }: { street: StreetSynthesisData | null | undefined }) {
  if (!street) return null;
  return (
    <div className="flex items-center gap-1 shrink-0">
      <span
        className={cn(
          "text-[9px] font-bold uppercase tracking-wide px-1.5 py-0.5 rounded border",
          TONE_CHIP[street.tone],
        )}
        title="Blended soft Street tone — does not change Our Fund score"
      >
        {TONE_LABEL[street.tone] ?? street.tone}
      </span>
      {street.eventRisk && (
        <span
          className="text-[9px] font-bold uppercase tracking-wide px-1.5 py-0.5 rounded border border-red-400 text-white bg-red-600/45"
          title="Large revision breadth or surprise streak — option haircut / ER caution"
        >
          Event risk
        </span>
      )}
    </div>
  );
}

function MetricRow({ m, i }: { m: Metric; i: number }) {
  return (
    <Tooltip delayDuration={150}>
      <TooltipTrigger asChild>
        <tr className={cn(gridRow(i), "cursor-help")}>
          <td className={cn(GRID_TD, "text-left font-semibold uppercase tracking-wide")}>
            {m.label}
          </td>
          <td className={cn(GRID_TD, "text-right font-mono font-semibold", m.tone ?? "text-white")}>
            {m.value}
          </td>
        </tr>
      </TooltipTrigger>
      <TooltipContent
        side="left"
        className="max-w-[280px] bg-zinc-950 text-white border border-[#d4af37]/40 text-[11px] leading-snug font-normal normal-case"
      >
        {m.tip}
      </TooltipContent>
    </Tooltip>
  );
}

export function StreetSynthesisCard({
  street,
  ticker,
}: {
  street: StreetSynthesisData | null | undefined;
  ticker: string;
}) {
  const [lane, setLane] = useState<"wrds" | "lseg">("wrds");
  if (!street) {
    return <p className="text-[12px] text-white italic">Street synthesis unavailable.</p>;
  }
  const lsegLive = street.sources.includes("lseg");
  const metrics = buildMetrics(street);
  const line = soWhat(street);

  return (
    <div className="flex flex-col h-full min-h-0 text-[11px] gap-1.5">
      <p className="text-[12px] text-white leading-snug font-medium">{line}</p>

      {metrics.length > 0 && (
        <div className={GRID_WRAP}>
          <table className="w-full border-collapse">
            <thead>
              <tr className={GRID_HEADER}>
                <th className={cn(GRID_TH, "text-left")}>Metric</th>
                <th className={cn(GRID_TH, "text-right")}>Value</th>
              </tr>
            </thead>
            <tbody>
              {metrics.map((m, i) => (
                <MetricRow key={m.key} m={m} i={i} />
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="flex items-center gap-1 shrink-0">
        {([
          ["wrds", "WRDS", "Open full WRDS revision / beat report"],
          ["lseg", "LSEG", lsegLive ? "Open StarMine forward ranks" : "No LSEG cache yet"],
        ] as const).map(([key, label, tip]) => {
          const on = lane === key;
          const lsegEmpty = key === "lseg" && !lsegLive;
          return (
            <Tooltip key={key} delayDuration={200}>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  onClick={() => setLane(key)}
                  className={cn(
                    "text-[10px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded border transition-colors",
                    on
                      ? "bg-[#d4af37] border-[#d4af37] text-black"
                      : "bg-transparent border-white/30 text-white hover:border-[#d4af37] hover:text-[#d4af37]",
                    lsegEmpty && !on && "opacity-45",
                  )}
                >
                  {label}
                </button>
              </TooltipTrigger>
              <TooltipContent
                side="top"
                className="bg-zinc-950 text-white border border-[#d4af37]/40 text-[11px]"
              >
                {tip}
              </TooltipContent>
            </Tooltip>
          );
        })}
        <span className="ml-auto text-[12px] font-mono font-bold text-[#d4af37] tracking-tight">
          {ticker.toUpperCase()}
        </span>
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto overscroll-contain border-t border-[#d4af37]/15 pt-1">
        {lane === "wrds" ? (
          <WrdsStreetPanel ticker={ticker} embedded />
        ) : (
          <LsegStreetPanel ticker={ticker} embedded />
        )}
      </div>
    </div>
  );
}
