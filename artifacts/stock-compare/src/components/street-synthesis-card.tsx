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

function clip(s: string | null | undefined, n = 48): string | null {
  if (!s) return null;
  const t = s.trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
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

  const bits = [
    clip(street.level.summary) && `L ${clip(street.level.summary, 36)}`,
    clip(street.path.summary) && `P ${clip(street.path.summary, 36)}`,
    clip(street.quality.summary) && `Q ${clip(street.quality.summary, 36)}`,
  ].filter(Boolean) as string[];
  const conflictHint =
    street.conflicts.length > 0
      ? `⚠ ${street.conflicts.length}`
      : null;
  const titleBits = [...bits, conflictHint].filter(Boolean).join(" · ");
  const fullTitle = [
    street.level.summary && `Level: ${street.level.summary}`,
    street.path.summary && `Path: ${street.path.summary}`,
    street.quality.summary && `Quality: ${street.quality.summary}`,
    ...street.conflicts.map((c) => `⚠ ${c.text}`),
    street.sources.length ? `Sources: ${street.sources.join(", ")}` : null,
  ]
    .filter(Boolean)
    .join("\n");

  return (
    <div className="flex flex-col h-full min-h-0 text-[11px]">
      {/* Single compressed header line */}
      <div className="shrink-0 flex items-center gap-1 min-w-0 pb-1 mb-1 border-b border-[#d4af37]/20">
        <span
          className={cn(
            "shrink-0 text-[9px] font-bold uppercase tracking-wide px-1.5 py-0.5 rounded border",
            TONE[street.tone],
          )}
        >
          {street.tone}
        </span>
        {street.eventRisk && (
          <span className="shrink-0 text-[9px] font-bold uppercase tracking-wide px-1.5 py-0.5 rounded border border-red-400 text-white bg-red-600/40">
            ER
          </span>
        )}
        <span
          className="min-w-0 flex-1 truncate text-[10px] text-amber-50 font-medium"
          title={fullTitle}
        >
          {titleBits || street.sources.join(" · ") || "—"}
        </span>
        <div className="shrink-0 flex items-center gap-0.5">
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

      {/* Lane fills remaining box — no nested border chrome */}
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
