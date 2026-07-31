// Intraday regime banner + checkpoint helpers (extracted from live.tsx).
import { useState } from "react";
import { Popover, PopoverTrigger, PopoverContent } from "@/components/ui/popover";
import { cn } from "@/lib/utils";

export type RegimeDirection = "bullish" | "bearish" | "mixed";

export interface RegimeCheckpoint {
  minAfterOpen: number;
  status: "pending" | "resolved";
  direction: RegimeDirection | null;
  confidence: number | null;
  label: string;
  computedLate: boolean;
  factors: string[];
}

// Market open is always 9:30 ET / 6:30 PT — both zones shift together on DST, so
// these are safe to hardcode rather than trust a computed label round-trip.
export const CHECKPOINT_TIME_PT: Record<number, string> = {
  15: "6:45 AM PT",
  30: "7:00 AM PT",
  45: "7:15 AM PT",
  60: "7:30 AM PT",
  90: "8:00 AM PT",
  120: "8:30 AM PT",
  150: "9:00 AM PT",
  180: "9:30 AM PT",
  210: "10:00 AM PT",
  270: "11:00 AM PT",
  330: "12:00 PM PT",
};

function regimeDotColor(c: RegimeCheckpoint): string {
  if (c.status === "pending" || c.direction == null) return "bg-amber-200/30";
  if (c.direction === "mixed") return "bg-yellow-500";
  return c.direction === "bullish" ? "bg-green-500" : "bg-red-500";
}

function regimeTextColor(c: RegimeCheckpoint): string {
  if (c.status === "pending" || c.direction == null) return "text-amber-200/40";
  if (c.direction === "mixed") return "text-yellow-500";
  return c.direction === "bullish" ? "text-green-500" : "text-red-500";
}

function regimeShortLabel(c: RegimeCheckpoint): string {
  if (c.status === "pending" || c.direction == null) return "—";
  if (c.direction === "mixed") return "Mix";
  return c.direction === "bullish" ? "Bull" : "Bear";
}

export function RegimeBanner({ checkpoints }: { checkpoints: RegimeCheckpoint[] | undefined }) {
  const [openMin, setOpenMin] = useState<number | null>(null);
  if (!checkpoints?.length) return null;

  const cols = checkpoints.length;

  // Headline = latest resolved directional call; flag a flip vs. the checkpoint
  // before it — a mid-day regime flip is the single most tradeable banner event.
  const resolved = checkpoints.filter(c => c.status === "resolved" && c.direction != null);
  const latest = resolved[resolved.length - 1] ?? null;
  const prev = resolved[resolved.length - 2] ?? null;
  const flipped = latest != null && prev != null && prev.direction !== latest.direction;

  return (
    <div className="rounded-md border border-[#d4af37]/25 overflow-hidden bg-zinc-950 shadow-lg shadow-black/60">
      <div className="px-3 py-1.5 border-b border-[#d4af37]/25 bg-black flex items-center justify-between gap-2">
        <span className="text-[11px] font-semibold text-[#d4af37] uppercase tracking-wide">
          Intraday Regime
        </span>
        {latest && (
          <span className="flex items-center gap-2 text-[11px] font-mono">
            <span className={cn("font-semibold", regimeTextColor(latest))}>
              Now: {regimeShortLabel(latest)}{latest.confidence != null ? ` ${latest.confidence}%` : ""}
            </span>
            <span className="text-amber-200/40">as of {CHECKPOINT_TIME_PT[latest.minAfterOpen] ?? latest.label}</span>
            {flipped && prev && (
              <span className="text-amber-400 font-semibold">
                ⚠ flipped from {regimeShortLabel(prev)} at {CHECKPOINT_TIME_PT[prev.minAfterOpen] ?? prev.label}
              </span>
            )}
          </span>
        )}
      </div>
      <div className="grid" style={{ gridTemplateColumns: `repeat(${cols}, 1fr)` }}>
        {checkpoints.map((c) => (
          <Popover key={c.minAfterOpen} open={openMin === c.minAfterOpen} onOpenChange={open => setOpenMin(open ? c.minAfterOpen : null)}>
            <PopoverTrigger asChild>
              <button
                className={cn(
                  "flex flex-col items-center gap-1 py-2 border-r border-[#d4af37]/10 last:border-r-0",
                  "even:bg-zinc-900/70 hover:bg-amber-500/10 transition-colors",
                )}
              >
                <span className="text-[10px] text-sky-300/70 font-mono whitespace-nowrap">
                  {CHECKPOINT_TIME_PT[c.minAfterOpen] ?? c.label}{c.computedLate ? "*" : ""}
                </span>
                <span className="flex items-center gap-1">
                  <span className={cn("h-1.5 w-1.5 rounded-full shrink-0", regimeDotColor(c))} />
                  <span className={cn("text-[10px] font-semibold whitespace-nowrap", regimeTextColor(c))}>
                    {regimeShortLabel(c)}{c.confidence != null ? ` ${c.confidence}%` : ""}
                  </span>
                </span>
              </button>
            </PopoverTrigger>
            <PopoverContent className="w-64 p-0 text-xs bg-zinc-950 border-[#d4af37]/25" align="center">
              <div className="px-3 py-2 border-b border-amber-500/20 bg-black flex items-center gap-2">
                <span className={cn("h-2 w-2 rounded-full shrink-0", regimeDotColor(c))} />
                <span className="font-semibold text-[#d4af37]">
                  {CHECKPOINT_TIME_PT[c.minAfterOpen] ?? c.label}{c.computedLate ? " (late)" : ""}
                </span>
              </div>
              <div className="p-3 flex flex-col gap-1.5">
                {(c.factors ?? []).length > 0 ? (c.factors ?? []).map((f, i) => (
                  <span key={i} className="text-sky-200/80 leading-snug font-mono text-[11px]">{f}</span>
                )) : (
                  <span className="text-amber-200/40 italic">No breakdown available.</span>
                )}
              </div>
            </PopoverContent>
          </Popover>
        ))}
      </div>
    </div>
  );
}
