import { cn } from "@/lib/utils";
import { WrdsStreetPanel } from "./wrds-street-panel";
import { LsegStreetPanel } from "./lseg-street-panel";
import { useState } from "react";

export type StreetSynthesisData = {
  ticker: string;
  tone: "supportive" | "neutral" | "caution";
  level: { summary: string | null };
  path: { summary: string | null };
  quality: { summary: string | null };
  eventRisk: boolean;
  conflicts: Array<{ code: string; text: string }>;
  sources: string[];
};

const TONE: Record<string, string> = {
  supportive: "border-green-400 text-white bg-green-600/40",
  neutral: "border-zinc-400 text-white bg-zinc-600/40",
  caution: "border-amber-400 text-white bg-amber-600/40",
};

const TONE_PLAIN: Record<string, string> = {
  supportive: "Street leans helpful",
  neutral: "Street mixed / middling",
  caution: "Street leans cautious",
};

/** Plain-English blurbs — WRDS = IBES revision history; LSEG = StarMine forward model. */
function laneExplainer(lane: "wrds" | "lseg"): string {
  return lane === "wrds"
    ? "WRDS/IBES: have analysts been raising estimates & beating? (history)"
    : "LSEG/StarMine: is the forward model healthy? (ranks, pred. surprise, drift)";
}

function humanHeader(street: StreetSynthesisData): { line: string; title: string } {
  const parts: string[] = [];
  if (street.path.summary) {
    // Prefer path (revisions / surprise) — that's what WRDS cares about
    parts.push(street.path.summary.replace(/\bIBES\b/g, "revisions").replace(/\bSUE\b/g, "beat score"));
  }
  if (street.quality.summary) {
    parts.push(street.quality.summary.replace(/\bARM\b/g, "est. momentum").replace(/α/g, "StarMine score"));
  }
  if (street.level.summary) {
    parts.push(street.level.summary);
  }
  const conflict = street.conflicts[0]?.text;
  const line =
    conflict ??
    (parts[0] ? parts[0] : TONE_PLAIN[street.tone] ?? street.tone);
  const title = [
    `${TONE_PLAIN[street.tone] ?? street.tone} (blended Yahoo+WRDS+LSEG — soft evidence only, not fund score).`,
    "",
    "These two feeds ask different questions and can disagree:",
    "• WRDS/IBES — revision breadth & historical beat score (SUE).",
    "• LSEG/StarMine — forward ranks (ARM, combined α), predicted surprise, 30d EPS drift.",
    "",
    street.level.summary && `Consensus / targets: ${street.level.summary}`,
    street.path.summary && `Revision path: ${street.path.summary}`,
    street.quality.summary && `LSEG quality: ${street.quality.summary}`,
    ...street.conflicts.map((c) => `Conflict: ${c.text}`),
    street.sources.length ? `Sources: ${street.sources.join(", ")}` : null,
  ]
    .filter(Boolean)
    .join("\n");
  return { line, title };
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
    return <p className="text-[10px] text-amber-100 italic">Street synthesis unavailable.</p>;
  }

  const { line, title } = humanHeader(street);
  const hasConflict = street.conflicts.length > 0;

  return (
    <div className="flex flex-col h-full min-h-0 text-[11px]">
      <div className="shrink-0 space-y-1 pb-1.5 mb-1 border-b border-[#d4af37]/20">
        <div className="flex items-center gap-1 min-w-0">
          <span
            className={cn(
              "shrink-0 text-[9px] font-bold uppercase tracking-wide px-1.5 py-0.5 rounded border",
              TONE[street.tone],
            )}
            title="Blended soft Street tone — does not change Our Fund score"
          >
            {street.tone}
          </span>
          {street.eventRisk && (
            <span
              className="shrink-0 text-[9px] font-bold uppercase tracking-wide px-1.5 py-0.5 rounded border border-red-400 text-white bg-red-600/40"
              title="Large |breadth| or |SUE| — option haircut / ER caution"
            >
              Event risk
            </span>
          )}
          {hasConflict && (
            <span className="shrink-0 text-[9px] font-bold uppercase tracking-wide px-1.5 py-0.5 rounded border border-amber-400/70 text-amber-100 bg-amber-600/30">
              Feeds disagree
            </span>
          )}
          <div className="shrink-0 flex items-center gap-0.5 ml-auto">
            {([
              ["wrds", "WRDS"],
              ["lseg", "LSEG"],
            ] as const).map(([key, label]) => {
              const on = lane === key;
              return (
                <button
                  key={key}
                  type="button"
                  onClick={() => setLane(key)}
                  title={laneExplainer(key)}
                  className={cn(
                    "text-[9px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded border transition-colors",
                    on
                      ? "bg-[#d4af37] border-[#d4af37] text-black"
                      : "bg-transparent border-white/25 text-amber-100 hover:border-[#d4af37] hover:text-[#d4af37]",
                  )}
                >
                  {label}
                </button>
              );
            })}
          </div>
        </div>
        <p className="text-[10px] text-amber-50/90 leading-snug line-clamp-2" title={title}>
          {line}
        </p>
        <p className="text-[9px] text-zinc-500 leading-snug">{laneExplainer(lane)}</p>
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto overscroll-contain">
        {lane === "wrds" ? (
          <WrdsStreetPanel ticker={ticker} embedded />
        ) : (
          <LsegStreetPanel ticker={ticker} embedded />
        )}
      </div>
    </div>
  );
}
