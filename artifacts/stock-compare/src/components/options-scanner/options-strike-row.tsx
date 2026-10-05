import { useSyncExternalStore } from "react";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { cn } from "@/lib/utils";
import { ChevronDown, X } from "lucide-react";
import type { OptionScoreResult } from "@/lib/option-scorer";
import { StrikeDetailPanel } from "@/components/strike-detail-panel";
import type { OptionRow, OptionsChainResult } from "./options-scanner-types";

// ── Strike row (one put per expiry table row) ─────────────────────────────────

// Only one non-modal strike popup can be open at a time page-wide — they all render at
// the same fixed screen position, so without this, opening a second one silently stacks
// on top of an unclosed first.
let openStrikeKey: string | null = null;
const openStrikeListeners = new Set<() => void>();
function setOpenStrikeKey(key: string | null) {
  openStrikeKey = key;
  openStrikeListeners.forEach(l => l());
}
function useOpenStrikeKey() {
  return useSyncExternalStore(
    (onChange) => {
      openStrikeListeners.add(onChange);
      return () => openStrikeListeners.delete(onChange);
    },
    () => openStrikeKey,
  );
}

export function StrikeRow({
  chain,
  put,
  isBest,
  optionScore,
  dataQuality,
  scoreResult,
  runnerUp,
  rowRef,
  isCall = false,
}: {
  chain: OptionsChainResult;
  put: OptionRow;
  isBest: boolean;
  optionScore?: number | null;
  dataQuality?: number | null;
  scoreResult?: OptionScoreResult | null;
  runnerUp?: { chain: OptionsChainResult; put: OptionRow; result: OptionScoreResult } | null;
  rowRef?: React.RefObject<HTMLDivElement | null>;
  isCall?: boolean;
}) {
  const rowKey = `${chain.ticker}-${chain.expiry}-${put.strike}-${isCall}`;
  const openKey = useOpenStrikeKey();
  const expanded = openKey === rowKey;
  const setExpanded = (next: boolean | ((prev: boolean) => boolean)) => {
    const nextVal = typeof next === "function" ? next(expanded) : next;
    setOpenStrikeKey(nextVal ? rowKey : null);
  };
  const exactDte      = chain.exactDte ?? Math.max(1, chain.daysToExpiry);
  const settlementDte = chain.settlementDte ?? exactDte;
  const weeklyIncome  = put.incomePct / (settlementDte / 7);
  const otmPct       = isCall
    ? ((put.strike - chain.spot) / chain.spot) * 100
    : ((chain.spot - put.strike) / chain.spot) * 100;
  const absDelta     = put.delta != null ? Math.abs(put.delta) : null;
  const pop          = absDelta != null ? (1 - absDelta) * 100 : null;
  const bufferSds    = put.iv > 0 && exactDte > 0
    ? (otmPct / 100) / (put.iv * Math.sqrt(exactDte / 365))
    : null;
  const gammaRisk    = exactDte <= 3 && absDelta != null && absDelta > 0.20;
  const incomeColor  =
    weeklyIncome >= 1.0 ? "text-green-400 font-semibold" :
    weeklyIncome >= 0.7 ? "text-yellow-400 font-semibold" : "text-white";
  const dqLabel = isBest && dataQuality != null
    ? dataQuality < 0.50 ? "sparse" : dataQuality < 0.80 ? "partial" : null
    : null;

  return (
    <div ref={rowRef}>
      <div
        className={cn(
          "grid items-center gap-x-3 px-3 py-0.5 text-xs border-l-2 transition-colors cursor-pointer select-none",
          "grid-cols-[80px_56px_72px_60px_52px_52px_60px_48px_1fr]",
          isBest
            ? "border-l-yellow-400 bg-yellow-400/10 hover:bg-yellow-400/15 ring-1 ring-inset ring-yellow-400/20"
            : gammaRisk
              ? "border-l-orange-500/60 bg-orange-950/20 hover:bg-orange-900/25"
              : "border-l-transparent bg-zinc-900/40 even:bg-zinc-800/40 hover:bg-zinc-700/50",
        )}
        onClick={() => setExpanded(e => !e)}
        title="Click to expand analysis"
      >
        {/* Strike */}
        <div className="flex items-center gap-1.5">
          <span className={cn("font-bold font-mono", isBest ? "text-yellow-300" : "text-yellow-400")}>
            ${Number.isInteger(put.strike) ? put.strike : put.strike.toFixed(1)}
          </span>
          {gammaRisk && <span className="text-[10px] text-orange-400" title="Gamma risk">⚡</span>}
        </div>
        {/* Bid — sellable price only. Never show "~last" as if it were a bid (Yahoo lastPrice
            is often stale/inverted across strikes). */}
        <div
          className={cn("font-mono", put.bidIsLive && put.bid > 0 ? "text-white" : "text-amber-200/35")}
          title={
            put.bidIsLive && put.bid > 0
              ? "Live bid (sellable)"
              : put.lastPrice > 0
                ? `No live bid — last trade $${put.lastPrice.toFixed(2)} (not used for ranking)`
                : "No live bid"
          }
        >
          {put.bidIsLive && put.bid > 0 ? `$${put.bid.toFixed(2)}` : "—"}
        </div>
        {/* %/wk */}
        <div
          className={cn("font-mono font-semibold", incomeColor)}
          title={
            put.bid > 0
              ? (
                `%/wk = (Bid ÷ Strike × 100) ÷ (Days until settlement ÷ 7)\n` +
                `= ($${put.bid.toFixed(2)} ÷ $${put.strike}) × 100 ÷ (${settlementDte.toFixed(1)} ÷ 7)\n` +
                `= ${put.incomePct.toFixed(3)}% total premium ÷ ${(settlementDte / 7).toFixed(2)} wks until settlement\n` +
                `= ${weeklyIncome.toFixed(2)}%/wk\n\n` +
                `Settlement days = ${exactDte.toFixed(1)} days to expiry + ${(settlementDte - exactDte).toFixed(0)}d settlement lag ` +
                `(options settle T+1 business day — e.g. Friday expiry → Monday)`
              )
              : "No live bid — weekly income not scored"
          }
        >
          {put.bid > 0 ? `${weeklyIncome.toFixed(2)}%` : "—"}
        </div>
        {/* OTM% */}
        <div className="font-mono text-white">{otmPct.toFixed(1)}%</div>
        {/* Delta */}
        <div className={cn("font-mono", absDelta == null ? "text-white" :
          absDelta < 0.15 ? "text-green-400" :
          absDelta < 0.25 ? "text-white" : "text-orange-400")}>
          {absDelta != null ? put.delta!.toFixed(2) : "—"}
        </div>
        {/* POP */}
        <div className={cn("font-mono", pop == null ? "text-white" :
          pop >= 85 ? "text-green-400" : pop >= 75 ? "text-white" : "text-orange-400")}>
          {pop != null ? `${pop.toFixed(0)}%` : "—"}
        </div>
        {/* Buffer (SDs) */}
        <div className={cn("font-mono", bufferSds == null ? "text-white" :
          bufferSds >= 1.5 ? "text-green-400" : bufferSds >= 1.0 ? "text-white" : "text-orange-400")}>
          {bufferSds != null ? `${bufferSds.toFixed(2)}σ` : "—"}
        </div>
        {/* IV */}
        <div className="font-mono text-amber-400">{(put.iv * 100).toFixed(0)}%</div>
        {/* Score + expand chevron */}
        <div className="flex items-center gap-1.5">
          {optionScore != null && (
            <span className={cn(
              "font-mono text-xs",
              isBest ? "text-yellow-300" : "text-white",
            )}>
              {optionScore.toFixed(1)}
            </span>
          )}
          {dqLabel && (
            <span className={cn(
              "text-[10px]",
              dqLabel === "partial" ? "text-yellow-400/70" : "text-red-400/70",
            )}>
              {dqLabel}
            </span>
          )}
          <span className="ml-auto text-white">
            <ChevronDown className={cn("w-3.5 h-3.5 transition-transform", expanded && "rotate-180")} />
          </span>
        </div>
      </div>
      {/* Non-modal: no overlay, no scroll lock, no focus trap — the scanner list stays
          fully scrollable/clickable behind this floating panel. */}
      <DialogPrimitive.Root open={expanded} onOpenChange={setExpanded} modal={false}>
        <DialogPrimitive.Portal>
          <DialogPrimitive.Content
            onOpenAutoFocus={e => e.preventDefault()}
            className="fixed z-50 right-4 bottom-4 w-[min(640px,calc(100vw-2rem))] max-h-[70vh] overflow-y-auto rounded-xl border border-border bg-background shadow-2xl p-4 data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95"
          >
            <div className="flex items-center justify-between mb-2">
              <DialogPrimitive.Title className="text-sm font-semibold text-white">
                {chain.ticker} ${Number.isInteger(put.strike) ? put.strike : put.strike.toFixed(1)} {isCall ? "call" : "put"} — exp {chain.expiry}
              </DialogPrimitive.Title>
              <DialogPrimitive.Close className="rounded-sm opacity-70 hover:opacity-100 text-white transition-opacity">
                <X className="w-4 h-4" />
              </DialogPrimitive.Close>
            </div>
            <StrikeDetailPanel
              put={put}
              chain={chain}
              scoreResult={scoreResult ?? null}
              isBest={isBest}
              runnerUp={isBest ? (runnerUp ?? null) : null}
              isCall={isCall}
            />
          </DialogPrimitive.Content>
        </DialogPrimitive.Portal>
      </DialogPrimitive.Root>
    </div>
  );
}

// ── Column header for the strike table ───────────────────────────────────────

export function StrikeTableHeader() {
  return (
    <div className={cn(
      "grid items-center gap-x-3 px-3 py-0.5 text-[10px] font-semibold tracking-wider uppercase",
      "grid-cols-[80px_56px_72px_60px_52px_52px_60px_48px_1fr]",
      "border-b border-zinc-600/40 bg-zinc-800/90 text-white",
    )}>
      <div>Strike</div>
      <div>Bid</div>
      <div>%/wk</div>
      <div>OTM%</div>
      <div>Delta</div>
      <div>POP</div>
      <div>Buffer</div>
      <div>IV</div>
      <div>Score</div>
    </div>
  );
}
