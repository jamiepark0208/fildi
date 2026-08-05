import { useState, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { ChevronDown, ChevronRight, RefreshCw, Loader2, X, Sparkles, ListFilter } from "lucide-react";
import { pickBestStrike, type StockContext, type OptionScoreResult } from "@/lib/option-scorer";
import type { TechnicalRow, TechnicalScore } from "@/lib/technical-rankings";
import type { MacroRegime } from "@/lib/option-scorer-constants";
import { useTickerTrackRecord } from "@/hooks/use-ticker-track-record";
import { TickerRecordBadge } from "@/components/live/ticker-record-badge";
import { pfNum, type OptionRow, type OptionsChainResult, type ScorecardRow, type IvTermPoint } from "./options-scanner-types";
import { viableOptionStrikes, optionStrikeSummary, buildReasoning } from "./options-scanner-helpers";
import { StrikeRow, StrikeTableHeader } from "./options-strike-row";
import { ExpirySection } from "./options-expiry-section";
import { IvTermStructureChart } from "./options-iv-chart";

function SignalBadge({ signal }: { signal: "GO" | "WATCH" | "NO" }) {
  const cls =
    signal === "GO"    ? "bg-green-500/15 text-green-400 border-green-500/30" :
    signal === "WATCH" ? "bg-yellow-500/15 text-yellow-400 border-yellow-500/30" :
                         "bg-muted text-white border-border";
  return (
    <Badge variant="outline" className={cn("text-[10px] px-1.5 py-0 h-4 font-bold", cls)}>
      {signal}
    </Badge>
  );
}

// ── Scanner Row ───────────────────────────────────────────────────────────────

interface ScannerRowProps {
  ticker: string;
  rowIndex: number;
  colorTag: string;
  indicator: ScorecardRow | null;
  score: TechnicalScore | null;
  optionsData: OptionsChainResult[] | null;
  optionsLoading: boolean;
  expanded: boolean;
  minIncome: number;
  overrideEnabled: boolean;
  onExpand: () => void;
  onRefresh?: () => void;
  onDelete: () => void;
  onOverride: () => void;
  // New scorer props (Phase 3 — used when USE_NEW_SCORER = true)
  techRow?: TechnicalRow | null;
  fundTotalScore?: number | null;
  macroRegime?: MacroRegime;
  allWatchlistIVs?: number[];
  strikeWeights?: Record<string, number>;
  bestOptionScore?: number | null;
  bestIncome?: number | null;
  bestBuffer?: number | null;
  stockScore?: number | null;
  isCall: boolean;
  // Today's Live-tab hotlist membership — dip hotlist = oversold (sell-put setup),
  // rally hotlist = overbought (sell-call setup). Surfaced here so a ticker flagged
  // there isn't missed in this table too.
  isOversold?: boolean;
  isOverbought?: boolean;
}

export function ScannerRow({
  ticker,
  rowIndex,
  colorTag,
  indicator,
  score,
  optionsData,
  optionsLoading,
  expanded,
  minIncome,
  overrideEnabled,
  onExpand,
  onRefresh,
  onDelete,
  onOverride,
  techRow,
  fundTotalScore,
  macroRegime = "BASELINE",
  allWatchlistIVs = [],
  strikeWeights,
  bestOptionScore = null,
  bestIncome = null,
  bestBuffer = null,
  stockScore = null,
  isCall,
  isOversold = false,
  isOverbought = false,
}: ScannerRowProps) {
  const { data: tickerRecords } = useTickerTrackRecord();

  // Put mode: legacy per-ticker RSI/MFI threshold signal (server scorecard).
  // Call mode: V2 call-side gate (overbought + fading momentum) from `score` —
  // the legacy indicator signal is oversold-based and would be backwards here.
  const signal    = isCall ? (score?.gateStatus ?? "NO") : (indicator?.signal ?? "NO");
  const price     = optionsData?.[0]?.spot ?? indicator?.price ?? null;
  const firstIV   = optionsData?.[0]?.puts?.[0]?.iv ?? null;

  // Call-mode red-flag warnings — warn only, never exclude (trader-context convention).
  const callWarnings = useMemo(() => {
    if (!isCall || !techRow) return [];
    const w: string[] = [];
    const ma50Atr = pfNum(techRow.priceVsMa50Atr);
    if (ma50Atr != null && ma50Atr > 2) w.push("Strong uptrend (+2 ATR above MA50) — capping a winner");
    const resist = [pfNum(techRow.swingHigh20d), pfNum(techRow.swingHigh50d), pfNum(techRow.pivotR1)]
      .filter((v): v is number => v != null);
    if (price != null && resist.length > 0 && price > Math.max(...resist)) w.push("Breakout above all resistance");
    return w;
  }, [isCall, techRow, price]);

  // Sub-tab within the expanded panel: strike table vs. the ticker's IV term structure.
  // Put vs. call is decided one level up (scanMode) — this row just renders whichever
  // side it's told to via `isCall`.
  const [subTab, setSubTab] = useState<"strikes" | "term">("strikes");

  const { data: ivTerm, isLoading: ivTermLoading } = useQuery({
    queryKey: ["iv-term-structure", ticker],
    queryFn: async (): Promise<IvTermPoint[]> => {
      const res = await fetch(`/api/options/${ticker}/term-structure`);
      if (!res.ok) throw new Error("term-structure fetch failed");
      return res.json();
    },
    enabled: expanded && subTab === "term",
    staleTime: 30 * 60 * 1000,
    retry: false,
  });

  // AI explanation — user-triggered only (button click), never fires just from
  // expanding the row. The deterministic buildReasoning() text is always shown as the
  // default, and on error/failure the AI text is never substituted in — the row never
  // breaks, it just doesn't get the richer context.
  const [aiRequested, setAiRequested] = useState(false);
  const { data: aiReasoning, isLoading: reasoningLoading, isError: reasoningError } = useQuery({
    queryKey: ["explain-options", ticker, indicator?.signal, indicator?.rsi?.toFixed(1), indicator?.mfi?.toFixed(1)],
    queryFn: async (): Promise<string> => {
      const res = await fetch("/api/explain/options", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ticker,
          rsi: indicator!.rsi,
          mfi: indicator!.mfi,
          signal: indicator!.signal,
          tier: indicator!.tier,
          ivCurrent: indicator!.ivCurrent ?? null,
          vsSpy20d: indicator!.vsSpy20d ?? null,
        }),
      });
      if (!res.ok) throw new Error("explain/options failed");
      return (await res.json()).explanation as string;
    },
    enabled: aiRequested && expanded && !!indicator,
    staleTime: 60 * 60 * 1000, // backend regenerates at most once/day — no need to refetch within the browser session sooner than this
    retry: false,
  });

  const strikes = optionsData
    ? viableOptionStrikes(optionsData, minIncome, isCall)
    : [];

  const stockCtx = useMemo((): StockContext | null => {
    if (!techRow) return null;
    return {
      ivRank:                pfNum(techRow.ivRank),
      ivPercentile:          pfNum(techRow.ivPercentile),
      ivVsRealizedVol:       pfNum(techRow.ivVsRealizedVol),
      basicSkew:             pfNum(techRow.basicSkew),
      swingLow20d:           pfNum(techRow.swingLow20d),
      swingLow50d:           pfNum(techRow.swingLow50d),
      pivotS1:               pfNum(techRow.pivotS1),
      swingHigh20d:          pfNum(techRow.swingHigh20d),
      swingHigh50d:          pfNum(techRow.swingHigh50d),
      pivotR1:               pfNum(techRow.pivotR1),
      nearestSupportDistPct: pfNum(techRow.nearestSupportDistPct),
      techTotalScore:        score?.totalScore ?? null,
      fundTotalScore:        fundTotalScore ?? null,
    };
  }, [techRow, score, fundTotalScore]);

  // strikeWeights is already resolved for the active side (put/call, tilt-adjusted or
  // user override) by the parent — no need to re-derive per row.
  const effectiveWeights = strikeWeights;
  const newScorerBest = useMemo(() => {
    if (!optionsData || !stockCtx) return null;
    const picked = pickBestStrike(
      optionsData.map(c => ({ ...c, options: isCall ? c.calls : c.puts })),
      stockCtx, macroRegime, allWatchlistIVs, undefined, effectiveWeights, isCall,
    );
    if (!picked) return null;
    return {
      chain: picked.chain as OptionsChainResult,
      put: picked.put as OptionRow,
      weeklyIncome: picked.result.weeklyIncome,
      optionScore: picked.result.optionScore,
      dataQuality: picked.result.dataQuality,
      runnerUp: picked.runnerUp as { chain: OptionsChainResult; put: OptionRow; result: OptionScoreResult } | null,
    };
  }, [optionsData, stockCtx, macroRegime, allWatchlistIVs, effectiveWeights, isCall]);

  const bestStrike = newScorerBest
    ?? (strikes.length > 0 ? strikes.reduce((a, b) => a.weeklyIncome > b.weeklyIncome ? a : b) : null);

  // Override: show the best strike even when no viable strikes exist at the current minIncome threshold
  const canOverride = strikes.length === 0 && optionsData !== null && !optionsLoading;
  const overrideStrikes = overrideEnabled && optionsData
    ? viableOptionStrikes(optionsData, 0, isCall)
    : [];
  const overrideBest = overrideStrikes.length > 0
    ? overrideStrikes.reduce((a, b) => a.weeklyIncome > b.weeklyIncome ? a : b)
    : null;

  // Prefer ivCurrent from scorecard (always loaded); fall back to options chain iv
  const ivPct = indicator?.ivCurrent && indicator.ivCurrent > 0
    ? indicator.ivCurrent.toFixed(0)
    : firstIV != null ? (firstIV * 100).toFixed(0) : null;
  const ivDisplay = ivPct != null ? `IV ${ivPct}%` : "IV —";

  const summary = optionsLoading ? null : optionStrikeSummary(optionsData, minIncome, isCall);

  const borderColor = colorTag || "transparent";

  const oversoldOverboughtBadge = isCall
    ? isOverbought && (
        <span
          className="ml-1.5 px-1 py-0 rounded border border-[#d4af37]/40 bg-[#d4af37]/10 text-[#d4af37] text-[9px] font-bold leading-none"
          title="In today's Live tab overbought (rally) hotlist"
        >
          OB
        </span>
      )
    : isOversold && (
        <span
          className="ml-1.5 px-1 py-0 rounded border border-[#d4af37]/40 bg-[#d4af37]/10 text-[#d4af37] text-[9px] font-bold leading-none"
          title="In today's Live tab oversold (dip) hotlist"
        >
          OS
        </span>
      );

  return (
    <div className={cn("border-b border-zinc-800 last:border-b-0", rowIndex % 2 === 0 ? "bg-zinc-900/70" : "bg-zinc-800/60")}>
      {/* Collapsed header row */}
      <div
        className="flex items-center gap-2 px-3 py-0.5 cursor-pointer hover:bg-amber-500/10 transition-colors select-none"
        style={{ borderLeft: `4px solid ${borderColor}` }}
        onClick={onExpand}
      >
        {/* Ticker */}
        <div className="w-[70px] shrink-0 flex items-center">
          <span
            className="font-bold text-xs tracking-wide"
            style={{ color: overrideEnabled ? "#f87171" : (colorTag || undefined) }}
          >
            {ticker}
          </span>
          {oversoldOverboughtBadge}
        </div>

        {/* Price */}
        <div className="w-[80px] shrink-0">
          {price != null && (
            <span className="text-xs font-mono font-semibold text-cyan-400">${price.toFixed(2)}</span>
          )}
        </div>

        <div className="w-[56px] shrink-0 flex items-center gap-1">
          <SignalBadge signal={signal} />
          {callWarnings.length > 0 && (
            <span className="text-amber-400 text-[10px] leading-none" title={callWarnings.join(" · ")}>⚠</span>
          )}
        </div>

        {/* Win/loss track record — its own column, separate from ticker identity */}
        <div className="w-[64px] shrink-0">
          <TickerRecordBadge record={tickerRecords?.[ticker]?.[isCall ? "call" : "put"]} className="" />
        </div>

        {/* RSI — hover for full reasoning (threshold, tier, MFI, etc.).
            Call mode: green = overbought (favorable overwriting), tooltip = V2 call reason. */}
        <span
          className={cn(
            "text-xs font-mono font-semibold w-[48px] shrink-0",
            indicator == null ? "text-white" :
            (isCall ? indicator.rsi >= 65 : indicator.rsiOk) ? "text-green-400" : "text-orange-400",
          )}
          title={isCall ? (score?.reason ?? undefined) : (indicator ? buildReasoning(indicator, firstIV, macroRegime) : undefined)}
        >
          {indicator ? indicator.rsi.toFixed(1) : "—"}
        </span>

        {/* Option Score */}
        <span className={cn(
          "text-xs w-[90px] shrink-0 font-mono font-semibold",
          bestOptionScore == null ? "text-white" :
          bestOptionScore >= 70 ? "text-green-400" :
          bestOptionScore >= 50 ? "text-yellow-400" : "text-white",
        )}>
          {bestOptionScore != null ? bestOptionScore.toFixed(1) : "—"}
        </span>

        {/* Stock Score (blended tech+fund+relMove+option+tag) — matches "score" sort key */}
        <span className={cn(
          "text-xs w-[90px] shrink-0 font-mono font-semibold",
          stockScore == null ? "text-white" :
          stockScore >= 70 ? "text-green-400" :
          stockScore >= 50 ? "text-yellow-400" : "text-white",
        )}>
          {stockScore != null ? stockScore.toFixed(1) : "—"}
        </span>

        {/* IV — distinctly amber */}
        <span className="text-xs font-mono font-semibold text-amber-400 w-[52px] shrink-0">
          {ivPct != null ? `${ivPct}%` : "—"}
        </span>

        {/* Income% */}
        <span className="text-xs font-mono font-semibold text-white w-[72px] shrink-0">
          {bestIncome != null && bestIncome >= 0 ? `${bestIncome.toFixed(2)}%` : "—"}
        </span>

        {/* Buffer (SDs OTM) */}
        <span className="text-xs font-mono font-semibold text-white w-[64px] shrink-0">
          {bestBuffer != null && bestBuffer >= 0 ? `${bestBuffer.toFixed(2)}σ` : "—"}
        </span>

        <div className="flex-1" />

        {/* Actions */}
        <div className="flex items-center gap-1 shrink-0" onClick={e => e.stopPropagation()}>
          {onRefresh && (
            <button
              className="p-1 rounded hover:bg-secondary text-white transition-colors"
              onClick={onRefresh}
              title="Refresh options"
            >
              <RefreshCw className="w-3 h-3" />
            </button>
          )}
          <button
            className="p-1 rounded hover:bg-secondary text-white hover:text-red-400 transition-colors"
            onClick={onDelete}
            title="Remove from scanner"
          >
            <X className="w-3 h-3" />
          </button>
        </div>
        {expanded
          ? <ChevronDown className="w-4 h-4 text-white shrink-0" />
          : <ChevronRight className="w-4 h-4 text-white shrink-0" />
        }
      </div>

      {/* Expanded panel */}
      {expanded && (
        <div
          className="px-3 pb-1.5 pt-1 space-y-1 bg-neutral-950/80"
          style={{ borderLeft: `4px solid ${borderColor}` }}
        >
          {/* Deterministic reasoning now shown as a hover tooltip on the RSI value in the
              ticker row above. AI context (outlier moves, sector flow, news) is opt-in via
              the button below since it costs an API call. */}
          <div className="flex items-center justify-between gap-3 flex-wrap">
            <div className="flex items-center gap-1.5 flex-wrap">
              {/* Sub-tabs: strike table vs. this ticker's IV term structure. Puts vs. calls
                  is decided by the page-level Sell Puts/Sell Calls toggle, not here. */}
              <div className="flex items-center rounded-full border border-border/60 bg-slate-900/40 p-0.5 text-[11px] shrink-0">
                <button
                  onClick={e => { e.stopPropagation(); setSubTab("strikes"); }}
                  className={cn(
                    "px-2.5 py-0.5 rounded-full transition-colors",
                    subTab === "strikes" ? "bg-primary/20 text-primary font-semibold" : "text-white/70 hover:text-white",
                  )}
                >
                  {isCall ? "Calls" : "Puts"}
                </button>
                <button
                  onClick={e => { e.stopPropagation(); setSubTab("term"); }}
                  className={cn(
                    "px-2.5 py-0.5 rounded-full transition-colors",
                    subTab === "term" ? "bg-primary/20 text-primary font-semibold" : "text-white/70 hover:text-white",
                  )}
                >
                  IV Term
                </button>
              </div>

              {subTab === "strikes" && (
                <span
                  className={cn(
                    "inline-flex items-center gap-1.5 text-xs px-2.5 py-1 rounded-full border",
                    summary == null || summary.startsWith("no viable")
                      ? "border-border/60 bg-slate-900/40 text-white/70"
                      : "border-primary/30 bg-primary/10 text-white",
                  )}
                >
                  <ListFilter className="w-3 h-3 text-primary shrink-0" />
                  {optionsLoading ? <Loader2 className="w-3 h-3 animate-spin" /> : (summary ?? "—")}
                </span>
              )}
            </div>

            {subTab === "strikes" && indicator && (
              aiReasoning ? null : (
                <button
                  onClick={() => setAiRequested(true)}
                  disabled={reasoningLoading}
                  className="flex items-center gap-1.5 text-[11px] font-medium text-primary border border-primary/30 bg-primary/5 rounded-full px-2.5 py-1 hover:bg-primary/15 hover:border-primary/50 disabled:opacity-60 disabled:cursor-default transition-colors"
                >
                  {reasoningLoading
                    ? <Loader2 className="w-3 h-3 animate-spin" />
                    : <Sparkles className="w-3 h-3" />}
                  {reasoningLoading ? "Getting AI context…" : "Get AI context"}
                </button>
              )
            )}
          </div>
          {subTab === "strikes" && indicator && aiReasoning && (
            <p className="text-xs text-primary/90 leading-snug border-l-2 border-primary/30 pl-2 py-0.5">
              {aiReasoning}
            </p>
          )}
          {subTab === "strikes" && reasoningError && (
            <p className="text-[11px] text-destructive/80">Couldn't get AI context — try again later.</p>
          )}

          {/* IV term structure tab */}
          {subTab === "term" && (
            <IvTermStructureChart data={ivTerm} isLoading={ivTermLoading} />
          )}

          {/* Strike cards — puts or calls, decided by the isCall prop from the page-level toggle */}
          {subTab === "strikes" && optionsLoading && (
            <div className="flex items-center gap-2 text-xs text-white">
              <Loader2 className="w-3 h-3 animate-spin" />
              Loading options…
            </div>
          )}

          {subTab === "strikes" && !optionsLoading && optionsData && strikes.length > 0 && (() => {
            // Group strikes by expiry, preserving chronological chain order
            const byExpiry = new Map<string, { chain: OptionsChainResult; puts: Array<{ put: OptionRow; weeklyIncome: number }> }>();
            for (const { chain, put, weeklyIncome } of strikes) {
              if (!byExpiry.has(chain.expiry)) byExpiry.set(chain.expiry, { chain, puts: [] });
              byExpiry.get(chain.expiry)!.puts.push({ put, weeklyIncome });
            }
            // Puts: highest strike (closest to money) first. Calls: lowest strike first — same idea, mirrored.
            for (const group of byExpiry.values()) {
              group.puts.sort((a, b) => isCall ? a.put.strike - b.put.strike : b.put.strike - a.put.strike);
            }
            return (
              <div className="space-y-1">
                {Array.from(byExpiry.values()).map(({ chain, puts }, idx) => (
                  <ExpirySection
                    key={chain.expiry}
                    chain={chain}
                    puts={puts}
                    bestStrike={bestStrike}
                    newScorerBest={newScorerBest}
                    stockCtx={stockCtx}
                    macroRegime={macroRegime}
                    allWatchlistIVs={allWatchlistIVs}
                    strikeWeights={effectiveWeights}
                    defaultCollapsed={idx > 0}
                    isCall={isCall}
                  />
                ))}
              </div>
            );
          })()}

          {subTab === "strikes" && !optionsLoading && optionsData && strikes.length === 0 && (
            <div className="space-y-2">
              <p className="text-xs text-white italic">
                {optionStrikeSummary(optionsData, minIncome, isCall)}
              </p>
              {canOverride && !overrideEnabled && (
                <button
                  onClick={e => { e.stopPropagation(); onOverride(); }}
                  className="text-xs px-2.5 py-1 rounded border border-amber-500/40 text-amber-400 hover:bg-amber-500/10 transition-colors"
                >
                  Override — show best {isCall ? "call" : "put"} anyway
                </button>
              )}
              {overrideEnabled && overrideBest && (
                <div className="space-y-1.5">
                  <p className="text-[11px] text-red-400/80 italic">Overridden — recommendation below does not meet normal criteria</p>
                  <div className="rounded-md border border-zinc-600/40 overflow-hidden bg-zinc-900/70 shadow-lg shadow-black/40">
                    <StrikeTableHeader />
                    <StrikeRow
                      chain={overrideBest.chain}
                      put={overrideBest.put}
                      isBest
                      isCall={isCall}
                    />
                  </div>
                </div>
              )}
              {overrideEnabled && overrideStrikes.length === 0 && (
                <p className="text-xs text-red-400/70 italic">No {isCall ? "calls" : "puts"} available even without income filter.</p>
              )}
            </div>
          )}

          {subTab === "strikes" && !optionsLoading && !optionsData && (
            <p className="text-xs text-white italic">No options data.</p>
          )}
        </div>
      )}
    </div>
  );
}
