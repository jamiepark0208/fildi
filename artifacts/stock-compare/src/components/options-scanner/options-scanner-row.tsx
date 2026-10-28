import { useState, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { ChevronDown, ChevronRight, RefreshCw, Loader2, X, Sparkles, ListFilter } from "lucide-react";
import { pickBestStrike, type StockContext, type OptionScoreResult } from "@/lib/option-scorer";
import type { TechnicalRow, TechnicalScore } from "@/lib/technical-rankings";
import type { MacroRegime } from "@/lib/option-scorer-constants";
import { useTickerTrackRecord } from "@/hooks/use-ticker-track-record";
import { useActivePanicPutBadges } from "@/hooks/use-strategy-signals";
import { TickerRecordBadge } from "@/components/live/ticker-record-badge";
import { RecConflictChip } from "@/components/live/rec-conflict-chip";
import { RiskWhatIfBadge } from "@/components/live/risk-what-if-badge";
import {
  pfNum, OPTIONS_BOARD_COLS, columnHeatStyle, type ColRange, type OptionRow, type OptionsChainResult,
  type ScorecardRow, type IvTermPoint,
} from "./options-scanner-types";
import {
  viableOptionStrikes, optionStrikeSummary, buildReasoning, assessOptionChainQuoteDq,
  isMonthlyOnlyCalendar,
} from "./options-scanner-helpers";
import { StrikeRow, StrikeTableHeader } from "./options-strike-row";
import { ExpirySection } from "./options-expiry-section";
import { IvTermStructureChart } from "./options-iv-chart";

/** Jamie contrast: white on zinc; hue on border only — never same-hue text-on-fill. */
function SignalBadge({ signal, title }: { signal: "GO" | "WATCH" | "NO"; title?: string }) {
  const cls =
    signal === "GO"    ? "bg-zinc-900 text-white border-emerald-400/70" :
    signal === "WATCH" ? "bg-zinc-900 text-white border-amber-400/70" :
                         "bg-zinc-900 text-zinc-300 border-zinc-500/50";
  return (
    <Badge variant="outline" title={title} className={cn("text-[8px] px-1 py-0 h-3.5 font-bold leading-none", cls)}>
      {signal}
    </Badge>
  );
}

const CHIP =
  "ml-0.5 px-0.5 py-px rounded border bg-zinc-900 text-white text-[8px] font-bold leading-none shrink-0";

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
  /** A256: snapshot came from watchlist relaxed second-pass. */
  snapRelaxed?: boolean;
  /** A277 (puts): the engine's contract — the expanded row re-prices it on the live chain instead of re-picking. */
  /** blocked = the engine's gate reasons (pass false): shown as ✕, not a rank (10-27: PLTR showed as #9 while gated). */
  enginePick?: { strike: number; expiry: string; why: string; tech?: Record<string, number | string | null> | null; blocked?: string | null } | null;
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
  snapRelaxed = false,
  enginePick = null,
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
  const { byTicker: panicByTicker } = useActivePanicPutBadges(3);
  const panicSig = panicByTicker.get(ticker.toUpperCase()) ?? null;

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
    // A277: a name with an engine pick shows that contract (live price), never a different "best" strike.
    const chains = enginePick
      ? optionsData.filter(c => c.expiry === enginePick.expiry).map(c => ({ ...c, options: c.puts.filter(p => p.strike === enginePick.strike) }))
      : optionsData.map(c => ({ ...c, options: isCall ? c.calls : c.puts }));
    // The engine already applied its gates/income view → score that contract without the scanner's own floors.
    const picked = enginePick
      ? pickBestStrike(chains, stockCtx, macroRegime, allWatchlistIVs, 0, effectiveWeights, isCall, { incomeFloor: 0, minStockQuality: 0 })
      : pickBestStrike(chains, stockCtx, macroRegime, allWatchlistIVs, undefined, effectiveWeights, isCall);
    if (!picked) return null;
    return {
      chain: picked.chain as OptionsChainResult,
      put: picked.put as OptionRow,
      weeklyIncome: picked.result.weeklyIncome,
      optionScore: picked.result.optionScore,
      dataQuality: picked.result.dataQuality,
      // A254: soft liquidity warning on the winning scanner row (not a gate).
      liquidity: picked.result.liquidity,
      runnerUp: picked.runnerUp as { chain: OptionsChainResult; put: OptionRow; result: OptionScoreResult } | null,
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps -- enginePick is a fresh object per render; its values are the key
  }, [optionsData, stockCtx, macroRegime, allWatchlistIVs, effectiveWeights, isCall, enginePick?.strike, enginePick?.expiry]);

  // An engine pick is the only "best" strike: if its contract isn't in the live chain, highlight nothing rather than
  // a max-income stand-in (10-28: GOOGL board 290 vs ladder ★ 287.5).
  const bestStrike = newScorerBest
    ?? (!enginePick && strikes.length > 0 ? strikes.reduce((a, b) => a.weeklyIncome > b.weeklyIncome ? a : b) : null);

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


  // A279 SuperTrend cluster % — display-only (S102); shown in Sig hover, not as a chip.
  const bull = typeof enginePick?.tech?.stc_bull === "number" ? enginePick.tech.stc_bull : null;

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
          {enginePick?.blocked ? (
            <span className="inline-flex w-4 h-4 items-center justify-center font-bold text-[9px] text-red-400/80"
                  title={`Engine blocks this put: ${enginePick.blocked}`}>✕</span>
          ) : rank != null && (
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

        {/* Ticker — keep clean; flags live in Sig/Opt/IV tooltips (not a chip pile). */}
        <div className="flex items-center min-w-0 overflow-hidden gap-0.5">
          <span
            className="font-bold text-[11px] tracking-wide font-mono shrink-0 text-white"
            style={{ color: overrideEnabled ? "#f87171" : (colorTag || undefined) }}
          >
            {ticker}
          </span>
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
              className={cn(CHIP, "border-amber-400/70")}
              title={`Earnings ${techRow.earningsDaysOut === 0 ? "today" : `in ${techRow.earningsDaysOut}d`} — elevated IV; prefer deep OTM`}
            >
              E{techRow.earningsDaysOut}
            </span>
          )}
          {panicSig && (
            <span
              className={cn(CHIP, "border-fuchsia-400/70")}
              title={panicSig.trigger || "Panic put (S054)"}
            >
              Panic
            </span>
          )}
        </div>

        {/* Price + Δ — wider col track; no overflow clip so % change stays visible */}
        <div
          className="flex items-baseline gap-0.5 min-w-0 whitespace-nowrap"
          title={snapSpot != null && snapSpot > 0 && price != null
            ? `Live ${price.toFixed(2)} · snapshot ${snapSpot.toFixed(2)}${vsSnapPct != null ? ` (${vsSnapPct >= 0 ? "+" : ""}${vsSnapPct.toFixed(1)}%)` : ""}`
            : "Live equity quote (Schwab→Yahoo cache)"}
        >
          {price != null ? (
            <span className="text-[11px] font-mono font-semibold text-cyan-400 tabular-nums shrink-0">
              ${price.toFixed(2)}
            </span>
          ) : null}
          {vsSnapPct != null && Math.abs(vsSnapPct) >= 1 && (
            <span
              className={cn(
                "text-[9px] font-mono font-semibold tabular-nums shrink-0",
                vsSnapPct <= -1 ? "text-red-400" : vsSnapPct >= 1 ? "text-emerald-400" : "text-muted-foreground",
              )}
            >
              {vsSnapPct >= 0 ? "+" : ""}{vsSnapPct.toFixed(1)}%
            </span>
          )}
        </div>

        <div className="flex items-center gap-0.5 min-w-0">
          <SignalBadge
            signal={signal}
            title={[
              signalTitle,
              isCall && isOverbought ? "Live overbought hotlist" : null,
              !isCall && isOversold ? "Live oversold hotlist" : null,
              bull != null ? `SuperTrend ${Math.round(bull * 100)}% bullish (display only · S102)` : null,
              isMonthlyOnlyCalendar(optionsData) ? "Monthly-only options calendar" : null,
              snapRelaxed ? "Relaxed watchlist pick (not strict Overall)" : null,
              callWarnings.length ? callWarnings.join(" · ") : null,
            ].filter(Boolean).join("\n") || undefined}
          />
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
            const hasSim = !isCall && !graded && !!rec?.simRec;
            if (!graded && !hasOpen && !hasSim) {
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

        {/* RSI — same 9px mono as Rec */}
        <span
          className={cn(
            "text-[9px] font-mono font-semibold tabular-nums min-w-0",
            indicator == null ? "text-white" :
            (isCall ? indicator.rsi >= 65 : indicator.rsiOk) ? "text-green-400" : "text-orange-400",
          )}
          title={isCall ? (score?.reason ?? undefined) : (indicator ? buildReasoning(indicator, firstIV, macroRegime) : undefined)}
        >
          {indicator ? indicator.rsi.toFixed(1) : "—"}
        </span>

        {/* Option Score — RYG text heat. Vendor (Schwab/Yahoo) only on expand DQ, not board. */}
        <span
          className={cn(
            "text-[11px] font-mono font-semibold tabular-nums min-w-0",
            bestOptionScore == null && "text-white/40",
          )}
          style={bestOptionScore != null ? columnHeatStyle(bestOptionScore, heat?.opt) : undefined}
          title={
            bestOptionScore == null
              ? (scoreNAReason ?? "N/A")
              : (newScorerBest?.liquidity?.warn
                ? `Liquidity warning: ${newScorerBest.liquidity.reason ?? "thin book"} (does not exclude)`
                : undefined)
          }
        >
          {bestOptionScore != null ? bestOptionScore.toFixed(1) : "N/A"}
          {newScorerBest?.liquidity?.warn && (
            <span className="ml-0.5 text-[8px] font-bold text-orange-300" title={`LIQ: ${newScorerBest.liquidity.reason ?? "thin book"}`}>!</span>
          )}
        </span>

        {/* Stock Score */}
        <span
          className={cn(
            "text-[11px] font-mono font-semibold tabular-nums min-w-0",
            stockScore == null && "text-white/40",
          )}
          style={stockScore != null ? columnHeatStyle(stockScore, heat?.stock) : undefined}
        >
          {stockScore != null ? stockScore.toFixed(1) : "—"}
        </span>

        {/* IV — mover Δ is a mark + hover (A81 facts), not a grey essay under the row */}
        <span
          className={cn(
            "text-[11px] font-mono font-semibold tabular-nums min-w-0 inline-flex items-baseline gap-0.5",
            ivPct == null && "text-white/40",
          )}
          style={ivNum != null ? columnHeatStyle(ivNum, heat?.iv) : undefined}
          title={
            moverFactLine
              ? `IV vs yesterday / realized vol (A81 mover facts — descriptive, not a sell/wait call)\n${moverFactLine}`
              : undefined
          }
        >
          {ivPct != null ? `${ivPct}%` : "—"}
          {moverFactLine && (
            <span className="text-[8px] font-bold text-cyan-300">Δ</span>
          )}
        </span>

        {/* Income% */}
        <span
          className={cn(
            "text-[11px] font-mono font-semibold tabular-nums min-w-0",
            !(bestIncome != null && bestIncome >= 0) && "text-white/40",
          )}
          style={bestIncome != null && bestIncome >= 0 ? columnHeatStyle(bestIncome, heat?.inc) : undefined}
          title={bestIncome != null && bestIncome >= 0 ? undefined : (scoreNAReason ?? "N/A")}
        >
          {bestIncome != null && bestIncome >= 0 ? `${bestIncome.toFixed(2)}%` : "N/A"}
        </span>

        {/* Buffer — σ of expected move to recommended strike */}
        <span
          className={cn(
            "text-[11px] font-mono font-semibold tabular-nums min-w-0",
            !(bestBuffer != null && bestBuffer >= 0) && "text-white/40",
          )}
          style={bestBuffer != null && bestBuffer >= 0 ? columnHeatStyle(bestBuffer, heat?.buf) : undefined}
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

      {/* Expanded panel */}
      {expanded && (
        <div
          className="px-3 pb-1.5 pt-1 space-y-1 bg-neutral-950/80"
          style={{ borderLeft: `4px solid ${borderColor}` }}
        >
          {/* Expanded chrome: gold/white sub-tabs · summary · Book? · AI — no grey essay rows */}
          <div className="flex items-center justify-between gap-2 flex-wrap">
            <div className="flex items-center gap-1 flex-wrap">
              <div className="inline-flex items-center gap-0.5 shrink-0">
                <button
                  type="button"
                  onClick={e => { e.stopPropagation(); setSubTab("strikes"); }}
                  className={cn(
                    "text-[10px] font-bold px-2 py-0.5 rounded transition-colors",
                    subTab === "strikes" ? "bg-[#d4af37] text-black" : "text-white/80 hover:text-white hover:bg-white/10",
                  )}
                >
                  {isCall ? "Calls" : "Puts"}
                </button>
                <button
                  type="button"
                  onClick={e => { e.stopPropagation(); setSubTab("term"); }}
                  className={cn(
                    "text-[10px] font-bold px-2 py-0.5 rounded transition-colors",
                    subTab === "term" ? "bg-[#d4af37] text-black" : "text-white/80 hover:text-white hover:bg-white/10",
                  )}
                >
                  IV Term
                </button>
              </div>

              {subTab === "strikes" && (
                <span
                  className={cn(
                    "inline-flex items-center gap-1 text-[10px] font-mono font-semibold px-2 py-0.5 rounded border",
                    summary == null || summary.startsWith("no viable")
                      ? "border-white/25 text-white/80"
                      : "border-[#d4af37]/40 text-white bg-zinc-900",
                  )}
                  title="Viable strikes for this side · best weekly income · quote vendor"
                >
                  <ListFilter className="w-3 h-3 text-[#d4af37] shrink-0" />
                  {optionsLoading ? <Loader2 className="w-3 h-3 animate-spin" /> : (summary ?? "—")}
                </span>
              )}

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
            </div>

            {subTab === "strikes" && indicator && (
              aiReasoning ? null : (
                <button
                  type="button"
                  onClick={() => setAiRequested(true)}
                  disabled={reasoningLoading}
                  className="flex items-center gap-1 text-[10px] font-bold text-white border border-[#d4af37]/40 bg-zinc-900 rounded px-2 py-0.5 hover:border-[#d4af37]/80 disabled:opacity-60 transition-colors"
                >
                  {reasoningLoading
                    ? <Loader2 className="w-3 h-3 animate-spin" />
                    : <Sparkles className="w-3 h-3 text-[#d4af37]" />}
                  {reasoningLoading ? "AI…" : "AI context"}
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
            // Chains load from the saved DB snapshot first (10-28) — say how old the quotes are; `stale` = server is refreshing it.
            const fetchedAt = strikes[0]?.chain.fetchedAt;
            const ageMin = fetchedAt ? Math.round((Date.now() - fetchedAt) / 60_000) : null;
            const stale = strikes.some((s) => s.chain.stale);
            return (
              <div className="space-y-1">
                {ageMin != null && (
                  <p className={`text-[10px] ${stale ? "text-amber-300/80" : "text-white/50"}`}>
                    Quotes as of {new Date(fetchedAt!).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}
                    {stale ? ` · ${ageMin < 120 ? `${ageMin} min` : `${Math.round(ageMin / 60)} h`} old · updating…` : ""}
                  </p>
                )}
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
