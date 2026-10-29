// Intraday regime banner + checkpoint helpers (extracted from live.tsx).
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Popover, PopoverTrigger, PopoverContent } from "@/components/ui/popover";
import { cn } from "@/lib/utils";

export type RegimeDirection = "bullish" | "bearish" | "mixed";

export type RiskLevel = "calm" | "normal" | "elevated" | "stormy";

/** S126 rest-of-day risk — the headline call (direction has no tested edge). */
export interface RegimeRisk {
  level: RiskLevel;
  pDropHalfAtr: number;
  halfAtrPct: number;
  state: "trend" | "range" | "quiet" | "volatile";
}

/** S130 1–2-week market put risk (daily, prior closes). */
export interface WeekRisk {
  flags: number;
  level: "low" | "normal" | "high";
  pBreach5d: number;
  vix: number;
  rv20: number;
  atrPct: number;
  er20: number;
}

const WEEK_TEXT: Record<WeekRisk["level"], string> = { low: "text-sky-400", normal: "text-zinc-200", high: "text-red-500" };

/** Every-bar rest-of-day risk (S139) + today's level changes. */
export interface LiveRisk {
  minAfterOpen: number;
  asOf: number;
  risk: RegimeRisk;
  events: Array<{ t: number; minAfterOpen: number; from: string | null; to: string; pDrop: number }>;
}

export interface RegimeCheckpoint {
  minAfterOpen: number;
  status: "pending" | "resolved";
  direction: RegimeDirection | null;
  confidence: number | null;
  risk?: RegimeRisk | null;
  weekRisk?: WeekRisk | null;
  label: string;
  computedLate: boolean;
  factors: string[];
}

/** Empirical next-slot frequencies (n-gated). Null = not enough history. */
export type SlotOutlook = {
  pBull: number;
  pMix: number;
  pBear: number;
  n: number;
  mode?: "path" | "base";
  fwdCloseP25?: number | null;
  fwdCloseP75?: number | null;
} | null;

export type RegimeOutlook = Record<number, SlotOutlook>;

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

const RISK_DOT: Record<RiskLevel, string> = { calm: "bg-sky-400", normal: "bg-zinc-300", elevated: "bg-amber-500", stormy: "bg-red-500" };
const RISK_TEXT: Record<RiskLevel, string> = { calm: "text-sky-400", normal: "text-zinc-200", elevated: "text-amber-400", stormy: "text-red-500" };
const RISK_SHORT: Record<RiskLevel, string> = { calm: "Calm", normal: "Norm", elevated: "Elev", stormy: "Storm" };

function regimeDotColor(c: RegimeCheckpoint): string {
  if (c.status === "resolved" && c.risk) return RISK_DOT[c.risk.level];
  if (c.status === "resolved" && c.direction == null && c.minAfterOpen === 15) return "bg-[#d4af37]/50";
  if (c.status === "pending" || c.direction == null) return "bg-amber-200/30";
  if (c.direction === "mixed") return "bg-yellow-500";
  return c.direction === "bullish" ? "bg-green-500" : "bg-red-500";
}

function regimeTextColor(c: RegimeCheckpoint): string {
  if (c.status === "resolved" && c.risk) return RISK_TEXT[c.risk.level];
  if (c.status === "resolved" && c.direction == null && c.minAfterOpen === 15) return "text-[#d4af37]";
  if (c.status === "pending" || c.direction == null) return "text-amber-200/40";
  if (c.direction === "mixed") return "text-yellow-500";
  return c.direction === "bullish" ? "text-green-500" : "text-red-500";
}

function regimeShortLabel(c: RegimeCheckpoint): string {
  if (c.status === "resolved" && c.risk) return RISK_SHORT[c.risk.level];
  // 15m slot always resolves as OR baseline (no breakout yet) — not a missed run.
  if (c.status === "resolved" && c.direction == null && c.minAfterOpen === 15) return "OR";
  if (c.status === "pending" || c.direction == null) return "—";
  if (c.direction === "mixed") return "Mix";
  return c.direction === "bullish" ? "Bull" : "Bear";
}

/** Risk cells show the tested drop odds; legacy (pre-S126) cells keep their direction + confidence. */
function cellLabel(c: RegimeCheckpoint): string {
  if (c.risk) return `${RISK_SHORT[c.risk.level]} ${Math.round(c.risk.pDropHalfAtr * 100)}%`;
  return `${regimeShortLabel(c)}${c.confidence != null ? ` ${c.confidence}%` : ""}`;
}

function fmtFwd(n: number): string {
  return `${n >= 0 ? "+" : ""}${n.toFixed(1)}%`;
}

/** Pending slots: probabilistic range (fwd p25–p75) or ~Bull/Mix/Bear %. */
export function pendingCellLabel(c: RegimeCheckpoint, outlook: RegimeOutlook | undefined): string {
  if (c.status !== "pending") return regimeShortLabel(c);
  const slot = outlook?.[c.minAfterOpen];
  if (!slot) return "—";
  if (slot.fwdCloseP25 != null && slot.fwdCloseP75 != null) {
    return `~${fmtFwd(slot.fwdCloseP25)}…${fmtFwd(slot.fwdCloseP75)}`;
  }
  // Bull/Bear frequencies are not shown as a call — S126: direction has no edge.
  return "—";
}

function pendingCellTip(c: RegimeCheckpoint, outlook: RegimeOutlook | undefined): string {
  const factors = (c.factors ?? []).join("\n");
  const slot = outlook?.[c.minAfterOpen];
  if (!slot) {
    return [
      "Not reached yet today.",
      "Not enough graded history yet (need ≥8 sessions) — dash until then.",
      factors,
    ].filter(Boolean).join("\n");
  }
  const src = slot.mode === "path"
    ? "days matching today's path so far"
    : "unconditional historical rate (thin path match)";
  const fwd =
    slot.fwdCloseP25 != null && slot.fwdCloseP75 != null
      ? `Fwd-to-close band (p25–p75): ${slot.fwdCloseP25}% … ${slot.fwdCloseP75}%`
      : null;
  return [
    `Historical next-slot frequency · ${src} · n=${slot.n}`,
    `Bull ${slot.pBull}% · Mix ${slot.pMix}% · Bear ${slot.pBear}%`,
    fwd,
    "Not a live forecast — empirical from past regime days.",
  ].filter(Boolean).join("\n");
}

// User-triggered AI one-liner on the checkpoint pattern so far today — never
// fires on its own, mirrors the options-scanner "Get AI context" pattern.
function RegimeAiInsight({ checkpoints }: { checkpoints: RegimeCheckpoint[] }) {
  const [requested, setRequested] = useState(false);
  const resolved = checkpoints.filter(c => c.status === "resolved");
  const latest = resolved[resolved.length - 1] ?? null;

  const { data: insight, isLoading, isError } = useQuery({
    queryKey: ["explain-live-regime", latest?.minAfterOpen, latest?.direction, latest?.confidence],
    queryFn: async (): Promise<string> => {
      const res = await fetch("/api/explain/live-regime", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          checkpoints: resolved.map(c => ({
            minAfterOpen: c.minAfterOpen, label: CHECKPOINT_TIME_PT[c.minAfterOpen] ?? c.label,
            direction: c.direction, confidence: c.confidence, factors: c.factors,
          })),
        }),
      });
      if (!res.ok) throw new Error("explain/live-regime failed");
      return (await res.json()).explanation as string;
    },
    enabled: requested && resolved.length > 0,
    staleTime: 60 * 60 * 1000,
    retry: false,
  });

  if (resolved.length === 0) return null;

  return (
    <div className="px-3 py-1.5 border-t border-[#d4af37]/10 bg-black/40 flex items-center gap-2 text-[11px]">
      {!requested ? (
        <button
          className="text-sky-300/70 hover:text-sky-300 underline decoration-dotted"
          onClick={() => setRequested(true)}
        >
          Get AI insight on today's pattern
        </button>
      ) : isLoading ? (
        <span className="text-amber-50/50 italic">Reading today's pattern…</span>
      ) : isError ? (
        <span className="text-amber-50/50 italic">AI insight unavailable right now.</span>
      ) : (
        <span className="text-sky-200/90 font-mono">{insight}</span>
      )}
    </div>
  );
}

export function RegimeBanner({
  checkpoints,
  outlook,
  live,
}: {
  checkpoints: RegimeCheckpoint[] | undefined;
  outlook?: RegimeOutlook;
  live?: LiveRisk | null;
}) {
  const [openMin, setOpenMin] = useState<number | null>(null);
  if (!checkpoints?.length) return null;

  const cols = checkpoints.length;

  // Headline = latest resolved directional call; flag a flip vs. the checkpoint
  // before it — a mid-day regime flip is the single most tradeable banner event.
  const resolved = checkpoints.filter(c => c.status === "resolved" && (c.risk != null || c.direction != null));
  const latest = resolved[resolved.length - 1] ?? null;
  const prev = resolved[resolved.length - 2] ?? null;
  const flipped = latest != null && prev != null && regimeShortLabel(prev) !== regimeShortLabel(latest);
  const week = [...checkpoints].reverse().find(c => c.weekRisk)?.weekRisk ?? null;

  return (
    <div className="rounded-md border border-[#d4af37]/25 overflow-hidden bg-zinc-950 shadow-lg shadow-black/60">
      <div className="px-3 py-1.5 border-b border-[#d4af37]/25 bg-black flex items-center justify-between gap-2">
        <span
          className="text-[11px] font-semibold text-[#d4af37] uppercase tracking-wide"
          title="Rest-of-day risk (S126, 479 SPY/QQQ sessions). % = historical odds of a further drop ≥ half a normal day's range before the close: calm 10%, normal 15%, elevated 20%, stormy 33%. Bull/bear direction has no tested edge (49.5%) — shown in the cell detail only."
        >
          Intraday Regime
        </span>
        {latest && (
          <span className="flex items-center gap-2 text-[11px] font-mono">
            <span className={cn("font-semibold", regimeTextColor(latest))}>
              Now: {cellLabel(latest)}
            </span>
            <span className="text-white">as of {CHECKPOINT_TIME_PT[latest.minAfterOpen] ?? latest.label}</span>
            {live && (
              <span
                className={cn("font-semibold", RISK_TEXT[live.risk.level])}
                title={`Recomputed on every completed 5-min bar (S139: beats the last fixed checkpoint, AUC 0.662 vs 0.655). Changes today: ${live.events.map(e => `${new Date(e.t).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })} ${e.from ?? "start"}→${e.to}`).join(", ") || "none"}.`}
              >
                · live {RISK_SHORT[live.risk.level]} {Math.round(live.risk.pDropHalfAtr * 100)}%
                {live.events.length > 1 ? ` (${live.events.length - 1} change${live.events.length > 2 ? "s" : ""})` : ""}
              </span>
            )}
            {week && (
              <span
                className={cn("font-semibold", WEEK_TEXT[week.level])}
                title={`1–2 week SPY put risk (S130 v2, 33 yrs): ${week.flags}/2 flags — ATR percentile ${Math.round(week.atrPct * 100)} (flag > 80), efficiency ${week.er20.toFixed(2)} (flag < 0.4). 5-day breach odds of a put sized by implied vol: 0 flags 5%, 1 9%, 2 13%. Realised vol ${week.rv20.toFixed(1)} vs VIX ${week.vix.toFixed(1)} shown for context (not a tested flag).`}
              >
                · 1–2 wk: {week.level} {Math.round(week.pBreach5d * 100)}%
              </span>
            )}
            {flipped && prev && (
              <span className="text-amber-400 font-semibold">
                ⚠ {latest.risk ? "changed" : "flipped"} from {regimeShortLabel(prev)} at {CHECKPOINT_TIME_PT[prev.minAfterOpen] ?? prev.label}
              </span>
            )}
          </span>
        )}
      </div>
      <div className="grid" style={{ gridTemplateColumns: `repeat(${cols}, 1fr)` }}>
        {checkpoints.map((c) => {
          const pending = c.status === "pending";
          const cellText = pending
            ? pendingCellLabel(c, outlook)
            : cellLabel(c);
          return (
          <Popover key={c.minAfterOpen} open={openMin === c.minAfterOpen} onOpenChange={open => setOpenMin(open ? c.minAfterOpen : null)}>
            <PopoverTrigger asChild>
              <button
                className={cn(
                  "flex flex-col items-center gap-0.5 py-1.5 border-r border-[#d4af37]/10 last:border-r-0",
                  "even:bg-zinc-900/70 hover:bg-amber-500/10 transition-colors",
                )}
                title={pending ? pendingCellTip(c, outlook) : undefined}
              >
                <span className="text-[10px] font-mono whitespace-nowrap text-white">
                  {CHECKPOINT_TIME_PT[c.minAfterOpen] ?? c.label}{c.computedLate ? "*" : ""}
                </span>
                <span className="flex items-center gap-1">
                  <span className={cn("h-1.5 w-1.5 rounded-full shrink-0", regimeDotColor(c))} />
                  <span className={cn(
                    "text-[10px] font-semibold whitespace-nowrap text-white",
                    pending && "italic font-normal",
                  )}>
                    {cellText}
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
                {pending ? (
                  <span className="text-amber-50/90 leading-snug font-mono text-[11px] whitespace-pre-wrap">
                    {pendingCellTip(c, outlook)}
                  </span>
                ) : (c.factors ?? []).length > 0 ? (c.factors ?? []).map((f, i) => (
                  <span key={i} className="text-sky-200/90 leading-snug font-mono text-[11px]">{f}</span>
                )) : (
                  <span className="text-amber-50/50 italic">No breakdown available.</span>
                )}
              </div>
            </PopoverContent>
          </Popover>
          );
        })}
      </div>
      <RegimeAiInsight checkpoints={checkpoints} />
    </div>
  );
}
