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
import { RecConflictChip } from "@/components/live/rec-conflict-chip";
import { RiskWhatIfBadge } from "@/components/live/risk-what-if-badge";
import {
  pfNum, OPTIONS_BOARD_COLS, columnHeatStyle, type ColRange, type OptionRow, type OptionsChainResult,
  type ScorecardRow, type IvTermPoint,
} from "./options-scanner-types";
import { viableOptionStrikes, optionStrikeSummary, buildReasoning, assessOptionChainQuoteDq } from "./options-scanner-helpers";
import { StrikeRow, StrikeTableHeader } from "./options-strike-row";
import { ExpirySection } from "./options-expiry-section";
import { IvTermStructureChart } from "./options-iv-chart";

function SignalBadge({ signal, title }: { signal: "GO" | "WATCH" | "NO"; title?: string }) {
  const cls =
    signal === "GO"    ? "bg-green-500/15 text-green-400 border-green-500/30" :
    signal === "WATCH" ? "bg-yellow-500/15 text-yellow-400 border-yellow-500/30" :
                         "bg-muted text-white border-border";
  return (
    <Badge variant="outline" title={title} className={cn("text-[8px] px-1 py-0 h-3.5 font-bold leading-none", cls)}>
      {signal}
    </Badge>
  );
}

// ── Scanner Row ───────────────────────────────────────────────────────────────

interface ScannerRowProps {
  ticker: string;
  /** 1-based display rank in the current sort order. */
  rank?: number;
  rowIndex: number;
  colorTag: string;
  indicator: ScorecardRow | null;
  score: TechnicalScore | null;
  optionsData: OptionsChainResult[] | null;
  optionsLoading: boolean;
  /** Set when chain fetch failed/timed out — stop spinner, show reason. */
  chainError?: string | null;
  expanded: boolean;
  minIncome: number;
  overrideEnabled: boolean;
  onExpand: () => void;
  /** Warm the options chain cache before expand (hover). */
  onPrefetch?: () => void;
  onRefresh?: () => void;
  onDelete: () => void;
  onOverride: () => void;
  /** Golden-source live equity price (Schwab→Yahoo cache). */
  livePrice?: number | null;
  /** Nightly options-snapshot underlying — for Δ vs live on crash/move days. */
  snapSpot?: number | null;
  // New scorer props (Phase 3 — used when USE_NEW_SCORER = true)
  techRow?: TechnicalRow | null;
  fundTotalScore?: number | null;
  /** WRDS IBES extreme revision/SUE — tighter ER haircut (puts and calls). */
  streetEventRisk?: boolean;
  macroRegime?: MacroRegime;
  allWatchlistIVs?: number[];
  strikeWeights?: Record<string, number>;
  bestOptionScore?: number | null;
  bestIncome?: number | null;
  bestBuffer?: number | null;
  /** Hover text when Opt/Inc/Buf are N/A. */
  scoreNAReason?: string | null;
  stockScore?: number | null;
  isCall: boolean;
  // Today's Live-tab hotlist membership — dip hotlist = oversold (sell-put setup),
  // rally hotlist = overbought (sell-call setup). Surfaced here so a ticker flagged
  // there isn't missed in this table too.
  isOversold?: boolean;
  isOverbought?: boolean;
  /** Latest Model List verdict is red (Avoid). This scanner's ranking is unvalidated, so the Model List wins. */
  modelAvoid?: boolean;
  /** A81 facts line (|day move|≥5%) — no advice takes. */
  moverFactLine?: string | null;
  /** Per-column min/max across the visible board — continuous heat (not 3-bin GY/R). */
  heat?: {
    opt?: ColRange | null;
    stock?: ColRange | null;
    iv?: ColRange | null;
    inc?: ColRange | null;
    buf?: ColRange | null;
  };
}

export function ScannerRow({
  ticker,
  rank,
  rowIndex,
  colorTag,
  indicator,
  score,
  optionsData,
  optionsLoading,
  chainError = null,
  expanded,
  minIncome,
  overrideEnabled,
  onExpand,
  onPrefetch,
  onRefresh,
  onDelete,
  onOverride,
  techRow,
  fundTotalScore,
  streetEventRisk = false,
  macroRegime = "BASELINE",
  allWatchlistIVs = [],
  strikeWeights,
  bestOptionScore = null,
  bestIncome = null,
  bestBuffer = null,
  scoreNAReason = null,
  stockScore = null,
  isCall,
  isOversold = false,
  isOverbought = false,
  modelAvoid = false,
  moverFactLine = null,
  livePrice = null,
  snapSpot = null,
  heat,
}: ScannerRowProps) {
  const { data: tickerRecords } = useTickerTrackRecord();

  // SIG = technical entry gate V2 (both sides). Puts: oversold+momentum. Calls: overbought+fade.
  // Prefer lane rankings gateStatus; fall back to legacy scorecard RSI/MFI for puts only.
  const signal: "GO" | "WATCH" | "NO" =
    score?.gateStatus ?? (isCall ? "NO" : (indicator?.signal ?? "NO"));
  const signalTitle = [
    score?.reason,
    !isCall && indicator && !score?.reason ? buildReasoning(indicator, null, macroRegime) : null,
    isOversold && !isCall ? "Live oversold hotlist (OS)" : null,
    isOverbought && isCall ? "Live overbought hotlist (OB)" : null,
    streetEventRisk ? "WRDS street-event risk" : null,
    techRow?.earningsDaysOut != null && techRow.earningsDaysOut >= 0 && techRow.earningsDaysOut <= 7
      ? `Earnings in ${techRow.earningsDaysOut}d`
      : null,
    bestOptionScore != null ? `Opt score ${bestOptionScore.toFixed(1)}` : null,
    "SIG = technical entry gate (not the option scorer)",
  ].filter(Boolean).join(" · ");
  // Price: golden-source live (Schwab→Yahoo 60s cache) first — not nightly snap, not
  // options-chain spot on expand. Fallback: scorecard → snap → chain.
  const fallbackSpot = (indicator?.price != null && indicator.price > 0)
    ? indicator.price
    : (snapSpot != null && snapSpot > 0 ? snapSpot : optionsData?.[0]?.spot ?? null);
  const price = livePrice != null && livePrice > 0 ? livePrice : fallbackSpot;
  const vsSnapPct = (livePrice != null && livePrice > 0 && snapSpot != null && snapSpot > 0)
    ? ((livePrice - snapSpot) / snapSpot) * 100
    : null;
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
      earningsDaysOut:       techRow.earningsDaysOut ?? null,
      streetEventRisk,
    };
  }, [techRow, score, fundTotalScore, streetEventRisk]);

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
  const ivNum = indicator?.ivCurrent && indicator.ivCurrent > 0
    ? (indicator.ivCurrent <= 1.5 ? indicator.ivCurrent * 100 : indicator.ivCurrent)
    : firstIV != null ? firstIV * 100 : null;
  const ivPct = ivNum != null ? ivNum.toFixed(0) : null;
  const ivDisplay = ivPct != null ? `IV ${ivPct}%` : "IV —";

  const summary = optionsLoading ? null : optionStrikeSummary(optionsData, minIncome, isCall);

  const borderColor = colorTag || "transparent";

  const flagCls =
    "ml-0.5 px-0.5 py-px rounded border border-[#d4af37]/35 bg-[#d4af37]/10 text-[#d4af37] text-[8px] font-bold leading-none shrink-0";
  const oversoldOverboughtBadge = isCall
    ? isOverbought && (
        <span className={flagCls} title="In today's Live tab overbought (rally) hotlist">OB</span>
      )
    : isOversold && (
        <span className={flagCls} title="In today's Live tab oversold (dip) hotlist">OS</span>
      );

  return (
    <div className={cn("border-b border-zinc-800 last:border-b-0", rowIndex % 2 === 0 ? "bg-zinc-900/70" : "bg-zinc-800/60")}>
      {/* Collapsed header row — same grid track as column headers */}
      <div
        className={cn(OPTIONS_BOARD_COLS, "px-1.5 py-0.5 cursor-pointer hover:bg-amber-500/10 transition-colors select-none")}
        style={{ borderLeft: `3px solid ${borderColor}` }}
        onClick={onExpand}
        onMouseEnter={onPrefetch}
        onFocus={onPrefetch}
      >
        {/* Rank */}
        <div className="text-center">
          {rank != null && (
            <span className={cn(
              "inline-flex w-4 h-4 rounded-full items-center justify-center font-bold text-[9px]",
              rank === 1 ? "bg-yellow-500 text-yellow-950" :
              rank === 2 ? "bg-slate-400 text-slate-950" :
              rank === 3 ? "bg-amber-700 text-amber-50" :
              "bg-secondary text-secondary-foreground",
            )}>
              {rank}
            </span>
          )}
        </div>

        {/* Ticker + tiny flags (clipped so they never overlap Price) */}
        <div className="flex items-center min-w-0 overflow-hidden">
          <span
            className="font-bold text-[11px] tracking-wide font-mono shrink-0"
            style={{ color: overrideEnabled ? "#f87171" : (colorTag || undefined) }}
          >
            {ticker}
          </span>
          {oversoldOverboughtBadge}
          {modelAvoid && (
            <RecConflictChip
              compact
              conflicts={[{
                ticker, code: "model_avoid", prefer: "model", severity: "warn",
                text: `${ticker}: Model List says Avoid (risk flags); this ranking is unvalidated`,
              }]}
            />
          )}
          {techRow?.earningsDaysOut != null && techRow.earningsDaysOut >= 0 && techRow.earningsDaysOut <= 7 && (
            <span
              className="ml-0.5 px-0.5 py-px rounded border border-amber-500/40 bg-amber-500/15 text-amber-200 text-[8px] font-bold leading-none shrink-0"
              title={`Earnings ${techRow.earningsDaysOut === 0 ? "today" : `in ${techRow.earningsDaysOut}d`} — elevated IV; prefer deep OTM`}
            >
              E{techRow.earningsDaysOut}
            </span>
          )}
        </div>

        {/* Price + Δ on one line (keeps row height to a single track) */}
        <div
          className="flex items-baseline gap-1 min-w-0 whitespace-nowrap overflow-hidden"
          title={snapSpot != null && snapSpot > 0 && price != null
            ? `Live ${price.toFixed(2)} · snapshot ${snapSpot.toFixed(2)}${vsSnapPct != null ? ` (${vsSnapPct >= 0 ? "+" : ""}${vsSnapPct.toFixed(1)}%)` : ""}`
            : "Live equity quote (Schwab→Yahoo cache)"}
        >
          {price != null ? (
            <span className="text-[11px] font-mono font-semibold text-cyan-400 tabular-nums">
              ${price.toFixed(2)}
            </span>
          ) : null}
          {vsSnapPct != null && Math.abs(vsSnapPct) >= 1 && (
            <span
              className={cn(
                "text-[9px] font-mono font-semibold tabular-nums",
                vsSnapPct <= -1 ? "text-red-400" : vsSnapPct >= 1 ? "text-emerald-400" : "text-muted-foreground",
              )}
            >
              {vsSnapPct >= 0 ? "+" : ""}{vsSnapPct.toFixed(1)}%
            </span>
          )}
        </div>

        <div className="flex items-center gap-0.5 min-w-0">
          <SignalBadge signal={signal} title={signalTitle} />
          {callWarnings.length > 0 && (
            <span className="text-amber-400 text-[9px] leading-none" title={callWarnings.join(" · ")}>⚠</span>
          )}
        </div>

        {/* Win/loss — compact W-L; Sharpe/StkΔ in tooltip. Empty = no graded model_recs yet. */}
        <div className="min-w-0 overflow-hidden">
          {(() => {
            const rec = tickerRecords?.[ticker]?.[isCall ? "call" : "put"];
            const graded = (rec?.wins ?? 0) + (rec?.losses ?? 0) > 0;
            const hasOpen = rec?.openSpot != null && rec.openSpot > 0;
            if (!graded && !hasOpen) {
              return (
                <span
                  className="text-[9px] font-mono text-zinc-500"
                  title="No graded live model recs for this ticker/side yet. Rec is accountability on real snapshots (model_recs), not a historical backtest. Expand Track Record or wait for Friday/nightly snapshots to grade."
                >
                  —
                </span>
              );
            }
            return (
              <TickerRecordBadge
                record={rec}
                livePrice={price}
                side={isCall ? "call" : "put"}
                className=""
                compact
              />
            );
          })()}
        </div>

        {/* RSI */}
        <span
          className={cn(
            "text-[11px] font-mono font-semibold tabular-nums min-w-0",
            indicator == null ? "text-white" :
            (isCall ? indicator.rsi >= 65 : indicator.rsiOk) ? "text-green-400" : "text-orange-400",
          )}
          title={isCall ? (score?.reason ?? undefined) : (indicator ? buildReasoning(indicator, firstIV, macroRegime) : undefined)}
        >
          {indicator ? indicator.rsi.toFixed(1) : "—"}
        </span>

        {/* Option Score */}
        <span
          className={cn(
            "text-[11px] font-mono font-semibold tabular-nums min-w-0 rounded-sm px-0.5 -mx-0.5",
            bestOptionScore != null ? "text-white" : "text-zinc-500",
          )}
          style={columnHeatStyle(bestOptionScore, heat?.opt)}
          title={bestOptionScore != null ? undefined : (scoreNAReason ?? "N/A")}
        >
          {bestOptionScore != null ? bestOptionScore.toFixed(1) : "N/A"}
        </span>

        {/* Stock Score */}
        <span
          className="text-[11px] font-mono font-semibold tabular-nums min-w-0 text-white rounded-sm px-0.5 -mx-0.5"
          style={columnHeatStyle(stockScore, heat?.stock)}
        >
          {stockScore != null ? stockScore.toFixed(1) : "—"}
        </span>

        {/* IV */}
        <span
          className="text-[11px] font-mono font-semibold tabular-nums min-w-0 text-white rounded-sm px-0.5 -mx-0.5"
          style={columnHeatStyle(ivNum, heat?.iv)}
        >
          {ivPct != null ? `${ivPct}%` : "—"}
        </span>

        {/* Income% */}
        <span
          className={cn(
            "text-[11px] font-mono font-semibold tabular-nums min-w-0 rounded-sm px-0.5 -mx-0.5",
            bestIncome != null && bestIncome >= 0 ? "text-white" : "text-zinc-500",
          )}
          style={columnHeatStyle(bestIncome, heat?.inc)}
          title={bestIncome != null && bestIncome >= 0 ? undefined : (scoreNAReason ?? "N/A")}
        >
          {bestIncome != null && bestIncome >= 0 ? `${bestIncome.toFixed(2)}%` : "N/A"}
        </span>

        {/* Buffer — σ of expected move to recommended strike */}
        <span
          className={cn(
            "text-[11px] font-mono font-semibold tabular-nums min-w-0 rounded-sm px-0.5 -mx-0.5",
            bestBuffer != null && bestBuffer >= 0 ? "text-white" : "text-zinc-500",
          )}
          style={columnHeatStyle(bestBuffer, heat?.buf)}
          title={
            bestBuffer != null && bestBuffer >= 0
              ? "OTM distance ÷ (strike IV × √(DTE/365)) for the snapshot strike"
              : (scoreNAReason ?? "N/A")
          }
        >
          {bestBuffer != null && bestBuffer >= 0 ? `${bestBuffer.toFixed(2)}σ` : "N/A"}
        </span>

        {/* Actions + expand chevron (must stay in this grid cell — a 13th item wraps a second row).
            stopPropagation only on refresh/delete so they don't toggle expand; the chevron must fire onExpand. */}
        <div className="flex items-center justify-end gap-0.5 h-5">
          {onRefresh && (
            <button
              type="button"
              className="p-0.5 rounded hover:bg-secondary text-white transition-colors"
              onClick={e => { e.stopPropagation(); onRefresh(); }}
              title="Refresh options"
            >
              <RefreshCw className="w-2.5 h-2.5" />
            </button>
          )}
          <button
            type="button"
            className="p-0.5 rounded hover:bg-secondary text-white hover:text-red-400 transition-colors"
            onClick={e => { e.stopPropagation(); onDelete(); }}
            title="Remove from scanner"
          >
            <X className="w-2.5 h-2.5" />
          </button>
          <button
            type="button"
            className="p-0.5 rounded hover:bg-secondary text-white transition-colors"
            onClick={e => { e.stopPropagation(); onExpand(); }}
            title={expanded ? "Collapse" : "Expand"}
            aria-expanded={expanded}
          >
            {expanded
              ? <ChevronDown className="w-3 h-3 shrink-0" />
              : <ChevronRight className="w-3 h-3 shrink-0" />
            }
          </button>
        </div>
      </div>

      {moverFactLine && (
        <div
          className="px-2 py-0.5 text-[10px] text-amber-100/65 font-mono border-t border-zinc-800/80"
          style={{ borderLeft: `3px solid ${borderColor}` }}
          title="A81 mover facts — no sell/wait take"
        >
          {moverFactLine}
        </div>
      )}

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

          {/* A136 — on-demand book risk for best put (same MC as Portfolio Alerts) */}
          {subTab === "strikes" && !isCall && bestStrike && price != null && price > 0 && (() => {
            const put = "put" in bestStrike ? bestStrike.put : null;
            const chain = "chain" in bestStrike ? bestStrike.chain : null;
            if (!put || !chain || !(put.iv > 0)) return null;
            return (
              <RiskWhatIfBadge
                compact
                input={{
                  account: "FILDI",
                  ticker,
                  strike: put.strike,
                  expiry: chain.expiry,
                  qty: 1,
                  iv: put.iv,
                  spot: price,
                  premium: put.bid > 0 ? put.bid : null,
                  surface: "scanner",
                }}
              />
            );
          })()}

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

          {subTab === "strikes" && !optionsLoading && optionsData && (() => {
            const dq = assessOptionChainQuoteDq(optionsData, isCall);
            if (!dq.degraded && dq.code === "ok") return null;
            return (
              <p
                className={cn(
                  "text-[10px] font-mono leading-snug px-1.5 py-1 rounded border mb-1",
                  dq.code === "zero_bids_schwab" || dq.code === "zero_bids_yahoo" || dq.code === "zero_bids"
                    ? "border-red-500/40 bg-red-500/10 text-red-200/90"
                    : "border-amber-500/30 bg-amber-500/10 text-amber-100/80",
                )}
                title="Sell income uses live bid only. Missing bids = vendor/quote DQ, not a strategy filter."
              >
                {dq.message}
              </p>
            );
          })()}

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

          {subTab === "strikes" && !optionsLoading && optionsData && optionsData.length === 0 && (
            <p className="text-xs text-amber-200/80 italic">
              {chainError ?? "Empty options chain for this name."}
            </p>
          )}

          {subTab === "strikes" && !optionsLoading && optionsData && optionsData.length > 0 && strikes.length === 0 && (
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
            <p className="text-xs text-amber-200/80 italic">
              {chainError ?? "No options data — thin chain or fetch failed."}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
