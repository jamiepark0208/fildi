import { useState, useMemo, useEffect, useRef } from "react";
import { cn } from "@/lib/utils";
import { ChevronDown, ChevronRight } from "lucide-react";
import { buildCandidate, computeOptionScore, type StockContext, type OptionScoreResult } from "@/lib/option-scorer";
import type { MacroRegime } from "@/lib/option-scorer-constants";
import { StrikeRow, StrikeTableHeader } from "./options-strike-row";
import { formatExpiry } from "./options-scanner-helpers";
import type { OptionRow, OptionsChainResult } from "./options-scanner-types";

// ── Expiry section (collapsible group of strikes for one expiry date) ─────────

export function ExpirySection({
  chain,
  puts,
  bestStrike,
  newScorerBest,
  stockCtx,
  macroRegime,
  allWatchlistIVs,
  strikeWeights,
  defaultCollapsed = false,
  isCall = false,
}: {
  chain: OptionsChainResult;
  puts: Array<{ put: OptionRow; weeklyIncome: number }>;
  bestStrike: { put: OptionRow; chain: OptionsChainResult } | null;
  newScorerBest: { chain: OptionsChainResult; put: OptionRow; optionScore: number; dataQuality: number; runnerUp: { chain: OptionsChainResult; put: OptionRow; result: OptionScoreResult } | null } | null;
  stockCtx: StockContext | null;
  macroRegime: MacroRegime;
  allWatchlistIVs: number[];
  strikeWeights?: Record<string, number>;
  defaultCollapsed?: boolean;
  isCall?: boolean;
}) {
  const [collapsed, setCollapsed] = useState(defaultCollapsed);
  const scrollRef = useRef<HTMLDivElement>(null);
  const bestRowRef = useRef<HTMLDivElement>(null);

  const hasBestStrike = bestStrike != null && bestStrike.chain.expiry === chain.expiry;
  const bestInExpiry  = puts.reduce((a, b) => a.weeklyIncome > b.weeklyIncome ? a : b, puts[0]);

  // Pre-scroll the capped strike list to the best-recommendation row as soon as it's expanded,
  // so the user sees it without manually scrolling — but keep strikes in their natural sort order.
  useEffect(() => {
    if (collapsed || !hasBestStrike) return;
    const container = scrollRef.current;
    const row = bestRowRef.current;
    if (!container || !row) return;
    container.scrollTop = row.offsetTop - container.offsetTop;
  }, [collapsed, hasBestStrike]);

  // Compute full OptionScoreResult for every put in this expiry
  const scoreResults = useMemo(() => {
    if (!stockCtx) return new Map<number, OptionScoreResult>();
    const map = new Map<number, OptionScoreResult>();
    for (const { put } of puts) {
      const candidate = buildCandidate(put, chain, isCall);
      map.set(put.strike, computeOptionScore(candidate, stockCtx, macroRegime, allWatchlistIVs, strikeWeights, isCall));
    }
    return map;
  }, [puts, chain, stockCtx, macroRegime, allWatchlistIVs, strikeWeights, isCall]);

  // Weeklies = amber; standard monthlies (3rd Friday / isWeekly=false) = sky — easy scan when
  // a name is monthly-only and defaults to that expiry.
  const monthly = chain.isWeekly === false;
  const headerTone = monthly
    ? "hover:bg-sky-500/20 bg-sky-500/10 border-b border-sky-500/30"
    : "hover:bg-amber-500/15 bg-amber-500/10 border-b border-amber-500/20";
  const shellTone = monthly
    ? "border-sky-500/40 bg-sky-950/40"
    : "border-zinc-600/40 bg-zinc-900/70";

  return (
    <div className={cn("rounded-md border overflow-hidden shadow-lg shadow-black/40", shellTone)}>
      <button
        className={cn(
          "w-full flex items-center gap-2 px-3 py-0.5 text-left transition-colors",
          headerTone,
        )}
        onClick={() => setCollapsed(c => !c)}
        title={monthly ? "Standard monthly expiry (3rd Friday)" : "Weekly expiry"}
      >
        {collapsed
          ? <ChevronRight className="w-3.5 h-3.5 text-white shrink-0" />
          : <ChevronDown className="w-3.5 h-3.5 text-white shrink-0" />
        }
        <span className={cn("font-bold text-xs tracking-wide", monthly ? "text-sky-200" : "text-foreground")}>
          {formatExpiry(chain.expiry, chain.daysToExpiry, chain.isWeekly)}
        </span>
        {monthly && (
          <span className="text-[9px] font-bold uppercase tracking-wide text-sky-300/90 bg-sky-500/15 border border-sky-400/30 rounded px-1 py-px">
            Mo
          </span>
        )}
        <span className="font-bold text-xs tracking-wide text-white">
          {puts.length} strike{puts.length !== 1 ? "s" : ""}
          {bestInExpiry ? ` · best ${bestInExpiry.weeklyIncome.toFixed(2)}%/wk` : ""}
        </span>
        {hasBestStrike && (
          <span className="ml-auto text-[10px] font-semibold text-yellow-300 bg-yellow-400/15 border border-yellow-400/30 rounded px-1.5 py-0.5 uppercase tracking-wide">
            Best
          </span>
        )}
      </button>

      {/* Strike table — capped at ~5 visible rows so multiple tickers' expiries can be
          compared without one long list pushing the rest off screen; scrolls for more. */}
      {!collapsed && (
        <div>
          <StrikeTableHeader />
          <div ref={scrollRef} className="max-h-[104px] overflow-y-auto">
            {puts.map(({ put }) => {
              const isBest = bestStrike != null &&
                put.strike === bestStrike.put.strike &&
                chain.expiry === bestStrike.chain.expiry;
              const sr = scoreResults.get(put.strike) ?? null;
              return (
                <StrikeRow
                  key={`${chain.expiry}-${put.strike}`}
                  rowRef={isBest ? bestRowRef : undefined}
                  chain={chain}
                  put={put}
                  isBest={isBest}
                  optionScore={isBest ? (newScorerBest?.optionScore ?? sr?.optionScore ?? null) : (sr?.optionScore ?? null)}
                  dataQuality={isBest ? (newScorerBest?.dataQuality ?? sr?.dataQuality ?? null) : (sr?.dataQuality ?? null)}
                  scoreResult={sr}
                  runnerUp={isBest ? (newScorerBest?.runnerUp ?? null) : null}
                  isCall={isCall}
                />
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
