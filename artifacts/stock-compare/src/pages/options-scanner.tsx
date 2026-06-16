import { useState, useMemo, useEffect } from "react";
import { useQuery, useQueries, useQueryClient } from "@tanstack/react-query";
import { Sidebar } from "@/components/sidebar";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { useWatchlist, PRESET_COLORS } from "@/hooks/use-watchlist";
import {
  computeTechnicalRankingsV2,
  type TechnicalRow,
  type IndicatorResult,
  type TechnicalScore,
} from "@/lib/technical-rankings";
import { ChevronDown, ChevronRight, RefreshCw, Loader2, Plus, X } from "lucide-react";
import { pickBestStrike, computeOptionScore, buildCandidate, type StockContext, type OptionScoreResult } from "@/lib/option-scorer";
import { computeRelativeMove, computeStockScore } from "@/lib/stock-scorer";
import { type MacroRegime, REGIME_INCOME_TARGET, REGIME_INCOME_FLOOR } from "@/lib/option-scorer-constants";
import { StrikeDetailPanel } from "@/components/strike-detail-panel";

// ── Types ─────────────────────────────────────────────────────────────────────

interface OptionRow {
  strike: number;
  bid: number;
  ask: number;
  lastPrice: number;
  iv: number;
  volume: number | null;
  openInterest: number | null;
  incomePct: number;
  meetsGate: boolean;
  delta: number | null;
  spreadPct: number | null;
}

interface OptionsChainResult {
  ticker: string;
  expiry: string;
  isWeekly: boolean;
  daysToExpiry: number;
  exactDte: number;
  spot: number;
  tier: 1 | 2 | 3;
  puts: OptionRow[];
  fetchedAt: number;
}

interface MacroRegimeResult {
  vix: number | null;
  spxChange1d: number | null;
  ndxChange1d: number | null;
  rutChange1d: number | null;
  regime: MacroRegime;
  indexDirection: "RALLY" | "NEUTRAL" | "CRASH";
  error?: string;
}

type ScorecardRow = IndicatorResult & { stale: boolean };
type SortKey = "optionScore" | "score" | "income" | "iv" | "otm" | "signal" | "buffer";

function pfNum(v: number | string | null | undefined): number | null {
  if (v == null) return null;
  const n = typeof v === "number" ? v : parseFloat(v as string);
  return Number.isFinite(n) ? n : null;
}

// ── Constants ─────────────────────────────────────────────────────────────────

const RED_TAG = "#ef4444";

const SORT_LABELS: { key: SortKey; label: string }[] = [
  { key: "optionScore", label: "Option Score" },
  { key: "score",       label: "Stock Score" },
  { key: "iv",          label: "IV%" },
  { key: "income",      label: "Income%" },
  { key: "buffer",      label: "Buffer" },
  { key: "signal",      label: "Signal" },
];

// ── Helpers ───────────────────────────────────────────────────────────────────

function formatExpiry(expiry: string, dte: number): string {
  const d     = new Date(expiry + "T12:00:00");
  const month = d.toLocaleString("en-US", { month: "short" });
  const weeks = Math.ceil(dte / 7);
  return `${month} ${d.getDate()} · ${weeks}wk`;
}

function minutesAgo(d: Date): string {
  const mins = Math.floor((Date.now() - d.getTime()) / 60_000);
  if (mins < 1) return "just now";
  return `${mins} min ago`;
}

function viableStrikes(
  chains: OptionsChainResult[],
  minWeeklyIncome: number,
  show1wk: boolean,
  show2wk: boolean,
): Array<{ chain: OptionsChainResult; put: OptionRow; weeklyIncome: number }> {
  return chains
    .filter(c => (show1wk && Math.ceil(c.daysToExpiry / 7) === 1) ||
                 (show2wk && Math.ceil(c.daysToExpiry / 7) >= 2))
    .flatMap(c => {
      const exactDte = c.exactDte ?? Math.max(1, c.daysToExpiry);
      return c.puts
        .map(p => ({ chain: c, put: p, weeklyIncome: p.incomePct / (exactDte / 7) }))
        .filter(x => x.weeklyIncome >= minWeeklyIncome);
    });
}

function strikeSummary(
  chains: OptionsChainResult[] | null,
  show1wk: boolean,
  show2wk: boolean,
): string {
  if (!chains) return "—";
  const strikes = viableStrikes(chains, 0.5, show1wk, show2wk);
  if (strikes.length === 0) return "no viable strikes";
  const best = Math.max(...strikes.map(s => s.weeklyIncome));
  return `${strikes.length} strike${strikes.length !== 1 ? "s" : ""} · best ${best.toFixed(2)}%/wk`;
}

function buildReasoning(d: ScorecardRow, firstIV: number | null, macroRegime: MacroRegime = "BASELINE"): string {
  if (d.signal === "GO") {
    const ivPct = d.ivCurrent && d.ivCurrent > 0
      ? d.ivCurrent.toFixed(0)
      : firstIV != null ? (firstIV * 100).toFixed(0) : null;
    const ivPart     = ivPct != null ? ` — IV ${ivPct}%` : "";
    const spyPart    = d.vsSpy20d != null
      ? `, ${d.vsSpy20d > 0 ? "up" : "down"} ${Math.abs(d.vsSpy20d).toFixed(1)}% vs SPY`
      : "";
    const regimePart = macroRegime !== "BASELINE" ? ` · ${macroRegime.replace("_", " ").toLowerCase()} regime` : "";
    return `RSI ${d.rsi.toFixed(1)} / ${d.rsiThreshold}, MFI ${d.mfi.toFixed(1)} / 25${spyPart}${ivPart}${regimePart}`;
  }
  if (d.signal === "WATCH") {
    if (!d.mfiOk) return `MFI ${d.mfi.toFixed(1)} slightly above 25 — monitor for weakening`;
    return `RSI ${d.rsi.toFixed(1)} near threshold ${d.rsiThreshold} — monitor`;
  }
  if (!d.rsiOk) return `RSI ${d.rsi.toFixed(1)} above threshold ${d.rsiThreshold}`;
  if (!d.mfiOk) return `MFI ${d.mfi.toFixed(1)} above 25`;
  if (d.return5d != null && d.return5d > 5) return `Up +${d.return5d.toFixed(1)}% in 5d — entry score reduced`;
  return "conditions not met";
}

// ── Sub-components ────────────────────────────────────────────────────────────

function SignalBadge({ signal }: { signal: "GO" | "WATCH" | "NO" }) {
  const cls =
    signal === "GO"    ? "bg-green-500/15 text-green-400 border-green-500/30" :
    signal === "WATCH" ? "bg-yellow-500/15 text-yellow-400 border-yellow-500/30" :
                         "bg-muted text-muted-foreground border-border";
  return (
    <Badge variant="outline" className={cn("text-[10px] px-1.5 py-0 h-4 font-bold", cls)}>
      {signal}
    </Badge>
  );
}

// ── Strike row (one put per expiry table row) ─────────────────────────────────

function StrikeRow({
  chain,
  put,
  isBest,
  optionScore,
  dataQuality,
  scoreResult,
}: {
  chain: OptionsChainResult;
  put: OptionRow;
  isBest: boolean;
  optionScore?: number | null;
  dataQuality?: number | null;
  scoreResult?: OptionScoreResult | null;
}) {
  const [expanded, setExpanded] = useState(false);
  const exactDte     = chain.exactDte ?? Math.max(1, chain.daysToExpiry);
  const weeklyIncome = put.incomePct / (exactDte / 7);
  const otmPct       = ((chain.spot - put.strike) / chain.spot) * 100;
  const absDelta     = put.delta != null ? Math.abs(put.delta) : null;
  const pop          = absDelta != null ? (1 - absDelta) * 100 : null;
  const bufferSds    = put.iv > 0 && exactDte > 0
    ? (otmPct / 100) / (put.iv * Math.sqrt(exactDte / 365))
    : null;
  const gammaRisk    = exactDte <= 3 && absDelta != null && absDelta > 0.20;
  const incomeColor  =
    weeklyIncome >= 1.0 ? "text-green-400 font-semibold" :
    weeklyIncome >= 0.7 ? "text-yellow-400 font-semibold" : "text-muted-foreground";
  const dqLabel = isBest && dataQuality != null
    ? dataQuality < 0.50 ? "sparse" : dataQuality < 0.80 ? "partial" : null
    : null;

  return (
    <div>
      <div
        className={cn(
          "grid items-center gap-x-4 px-3 py-2 text-sm border-l-2 transition-colors cursor-pointer select-none",
          "grid-cols-[80px_56px_72px_60px_52px_52px_60px_48px_1fr]",
          isBest
            ? "border-l-green-500 bg-green-500/5 hover:bg-green-500/8"
            : gammaRisk
              ? "border-l-orange-500/60 hover:bg-secondary/30"
              : "border-l-transparent hover:bg-secondary/30",
        )}
        onClick={() => setExpanded(e => !e)}
        title="Click to expand analysis"
      >
        {/* Strike */}
        <div className="flex items-center gap-1.5">
          <span className={cn("font-bold font-mono", isBest ? "text-green-300" : "text-slate-100")}>
            ${Number.isInteger(put.strike) ? put.strike : put.strike.toFixed(1)}
          </span>
          {gammaRisk && <span className="text-[10px] text-orange-400" title="Gamma risk">⚡</span>}
        </div>
        {/* Bid */}
        <div className="font-mono text-slate-200">${put.bid.toFixed(2)}</div>
        {/* %/wk */}
        <div className={cn("font-mono font-semibold", incomeColor)}>{weeklyIncome.toFixed(2)}%</div>
        {/* OTM% */}
        <div className="font-mono text-slate-300">{otmPct.toFixed(1)}%</div>
        {/* Delta */}
        <div className={cn("font-mono", absDelta == null ? "text-slate-500" :
          absDelta < 0.15 ? "text-green-400" :
          absDelta < 0.25 ? "text-slate-200" : "text-orange-400")}>
          {absDelta != null ? put.delta!.toFixed(2) : "—"}
        </div>
        {/* POP */}
        <div className={cn("font-mono", pop == null ? "text-slate-500" :
          pop >= 85 ? "text-green-400" : pop >= 75 ? "text-slate-200" : "text-orange-400")}>
          {pop != null ? `${pop.toFixed(0)}%` : "—"}
        </div>
        {/* Buffer (SDs) */}
        <div className={cn("font-mono", bufferSds == null ? "text-slate-500" :
          bufferSds >= 1.5 ? "text-green-400" : bufferSds >= 1.0 ? "text-slate-200" : "text-orange-400")}>
          {bufferSds != null ? `${bufferSds.toFixed(2)}σ` : "—"}
        </div>
        {/* IV */}
        <div className="font-mono text-amber-400">{(put.iv * 100).toFixed(0)}%</div>
        {/* Score + expand chevron */}
        <div className="flex items-center gap-1.5">
          {optionScore != null && (
            <span className={cn(
              "text-[11px] font-mono rounded px-1.5 py-0.5 border",
              isBest
                ? "text-green-300 bg-green-500/10 border-green-500/30"
                : "text-slate-300 bg-slate-500/10 border-slate-500/20",
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
          <span className="ml-auto text-slate-600">
            {expanded ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
          </span>
        </div>
      </div>
      {expanded && (
        <StrikeDetailPanel
          put={put}
          chain={chain}
          scoreResult={scoreResult ?? null}
          isBest={isBest}
        />
      )}
    </div>
  );
}

// ── Column header for the strike table ───────────────────────────────────────

function StrikeTableHeader() {
  return (
    <div className={cn(
      "grid items-center gap-x-4 px-3 py-1.5 text-[10px] font-semibold tracking-wider uppercase",
      "grid-cols-[80px_56px_72px_60px_52px_52px_60px_48px_1fr]",
      "border-b border-border/60 bg-slate-900/60 text-slate-400",
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

// ── Expiry section (collapsible group of strikes for one expiry date) ─────────

function ExpirySection({
  chain,
  puts,
  bestStrike,
  newScorerBest,
  stockCtx,
  macroRegime,
  allWatchlistIVs,
}: {
  chain: OptionsChainResult;
  puts: Array<{ put: OptionRow; weeklyIncome: number }>;
  bestStrike: { put: OptionRow; chain: OptionsChainResult } | null;
  newScorerBest: { chain: OptionsChainResult; put: OptionRow; optionScore: number; dataQuality: number } | null;
  stockCtx: StockContext | null;
  macroRegime: MacroRegime;
  allWatchlistIVs: number[];
}) {
  const [collapsed, setCollapsed] = useState(false);

  const hasBestStrike = bestStrike != null && bestStrike.chain.expiry === chain.expiry;
  const bestInExpiry  = puts.reduce((a, b) => a.weeklyIncome > b.weeklyIncome ? a : b, puts[0]);

  // Compute full OptionScoreResult for every put in this expiry
  const scoreResults = useMemo(() => {
    if (!stockCtx) return new Map<number, OptionScoreResult>();
    const map = new Map<number, OptionScoreResult>();
    for (const { put } of puts) {
      const candidate = buildCandidate(put, chain);
      map.set(put.strike, computeOptionScore(candidate, stockCtx, macroRegime, allWatchlistIVs));
    }
    return map;
  }, [puts, chain, stockCtx, macroRegime, allWatchlistIVs]);

  return (
    <div className="rounded-md border border-border/60 overflow-hidden">
      {/* Expiry group header */}
      <button
        className={cn(
          "w-full flex items-center gap-2 px-3 py-2 text-left transition-colors",
          "hover:bg-secondary/40 bg-secondary/20",
        )}
        onClick={() => setCollapsed(c => !c)}
      >
        {collapsed
          ? <ChevronRight className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
          : <ChevronDown className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
        }
        <span className="text-sm font-medium text-foreground">
          {formatExpiry(chain.expiry, chain.daysToExpiry)}
        </span>
        <span className="text-xs text-muted-foreground">
          {puts.length} strike{puts.length !== 1 ? "s" : ""}
          {bestInExpiry ? ` · best ${bestInExpiry.weeklyIncome.toFixed(2)}%/wk` : ""}
        </span>
        {hasBestStrike && (
          <span className="ml-auto text-[10px] font-semibold text-green-400 bg-green-500/10 border border-green-500/20 rounded px-1.5 py-0.5 uppercase tracking-wide">
            Best
          </span>
        )}
      </button>

      {/* Strike table */}
      {!collapsed && (
        <div>
          <StrikeTableHeader />
          {puts.map(({ put }) => {
            const isBest = bestStrike != null &&
              put.strike === bestStrike.put.strike &&
              chain.expiry === bestStrike.chain.expiry;
            const sr = scoreResults.get(put.strike) ?? null;
            return (
              <StrikeRow
                key={`${chain.expiry}-${put.strike}`}
                chain={chain}
                put={put}
                isBest={isBest}
                optionScore={isBest ? (newScorerBest?.optionScore ?? sr?.optionScore ?? null) : (sr?.optionScore ?? null)}
                dataQuality={isBest ? (newScorerBest?.dataQuality ?? sr?.dataQuality ?? null) : (sr?.dataQuality ?? null)}
                scoreResult={sr}
              />
            );
          })}
        </div>
      )}
    </div>
  );
}

// ── Scanner Row ───────────────────────────────────────────────────────────────

interface ScannerRowProps {
  ticker: string;
  colorTag: string;
  indicator: ScorecardRow | null;
  score: TechnicalScore | null;
  optionsData: OptionsChainResult[] | null;
  optionsLoading: boolean;
  expanded: boolean;
  show1wk: boolean;
  show2wk: boolean;
  minIncomeOn: boolean;
  overrideEnabled: boolean;
  onExpand: () => void;
  onRefresh: () => void;
  onDelete: () => void;
  onOverride: () => void;
  // New scorer props (Phase 3 — used when USE_NEW_SCORER = true)
  techRow?: TechnicalRow | null;
  fundTotalScore?: number | null;
  macroRegime?: MacroRegime;
  allWatchlistIVs?: number[];
}

function ScannerRow({
  ticker,
  colorTag,
  indicator,
  score,
  optionsData,
  optionsLoading,
  expanded,
  show1wk,
  show2wk,
  minIncomeOn,
  overrideEnabled,
  onExpand,
  onRefresh,
  onDelete,
  onOverride,
  techRow,
  fundTotalScore,
  macroRegime = "BASELINE",
  allWatchlistIVs = [],
}: ScannerRowProps) {
  const signal    = indicator?.signal ?? "NO";
  const price     = optionsData?.[0]?.spot ?? techRow?.price ?? null;
  const firstIV   = optionsData?.[0]?.puts?.[0]?.iv ?? null;
  const minIncome = minIncomeOn ? 0.5 : 0;

  const strikes = optionsData
    ? viableStrikes(optionsData, minIncome, show1wk, show2wk)
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
      nearestSupportDistPct: pfNum(techRow.nearestSupportDistPct),
      techTotalScore:        score?.totalScore ?? null,
      fundTotalScore:        fundTotalScore ?? null,
    };
  }, [techRow, score, fundTotalScore]);

  const newScorerBest = useMemo(() => {
    if (!optionsData || !stockCtx) return null;
    const picked = pickBestStrike(optionsData, stockCtx, macroRegime, allWatchlistIVs);
    if (!picked) return null;
    return {
      chain: picked.chain as OptionsChainResult,
      put: picked.put as OptionRow,
      weeklyIncome: picked.result.weeklyIncome,
      optionScore: picked.result.optionScore,
      dataQuality: picked.result.dataQuality,
    };
  }, [optionsData, stockCtx, macroRegime, allWatchlistIVs]);

  const bestStrike = newScorerBest
    ?? (strikes.length > 0 ? strikes.reduce((a, b) => a.weeklyIncome > b.weeklyIncome ? a : b) : null);

  // Override: show best put even when no viable strikes at current minIncome threshold
  const canOverride = strikes.length === 0 && optionsData !== null && !optionsLoading;
  const overrideStrikes = overrideEnabled && optionsData
    ? viableStrikes(optionsData, 0, show1wk, show2wk)
    : [];
  const overrideBest = overrideStrikes.length > 0
    ? overrideStrikes.reduce((a, b) => a.weeklyIncome > b.weeklyIncome ? a : b)
    : null;

  // Prefer ivCurrent from scorecard (always loaded); fall back to options chain iv
  const ivPct = indicator?.ivCurrent && indicator.ivCurrent > 0
    ? indicator.ivCurrent.toFixed(0)
    : firstIV != null ? (firstIV * 100).toFixed(0) : null;
  const ivDisplay = ivPct != null ? `IV ${ivPct}%` : "IV —";

  const summary = optionsLoading ? null : strikeSummary(optionsData, show1wk, show2wk);

  const borderColor = colorTag || "transparent";

  return (
    <div className="border-b border-border last:border-b-0">
      {/* Collapsed header row */}
      <div
        className="flex items-center gap-3 px-4 py-3 cursor-pointer hover:bg-secondary/30 transition-colors select-none"
        style={{ borderLeft: `4px solid ${borderColor}` }}
        onClick={onExpand}
      >
        {/* Left: ticker + price + signal */}
        <div className="flex items-center gap-2 w-[150px] shrink-0">
          <span
            className="font-bold text-sm tracking-wide"
            style={overrideEnabled ? { color: "#f87171" } : undefined}
          >
            {ticker}
          </span>
          {price != null && (
            <span className="text-xs font-mono font-semibold text-cyan-400">${price.toFixed(2)}</span>
          )}
        </div>

        <SignalBadge signal={signal} />

        {/* Score */}
        <span className="text-xs text-slate-300 w-[64px] shrink-0 font-mono">
          {score ? score.totalScore.toFixed(1) : "—"}
        </span>

        {/* IV — distinctly amber */}
        <span className="text-xs font-mono font-semibold text-amber-400 w-[52px] shrink-0">
          {ivPct != null ? `${ivPct}%` : "—"}
        </span>

        {/* Strike summary */}
        <span className={cn(
          "text-xs flex-1",
          summary?.startsWith("excluded") ? "text-slate-500 italic" :
          summary?.startsWith("no viable") ? "text-slate-500" : "text-slate-200",
        )}>
          {optionsLoading ? (
            <Loader2 className="w-3 h-3 animate-spin inline" />
          ) : (summary ?? "—")}
        </span>

        {/* Actions */}
        <div className="flex items-center gap-1 shrink-0" onClick={e => e.stopPropagation()}>
          <button
            className="p-1 rounded hover:bg-secondary text-slate-500 hover:text-slate-200 transition-colors"
            onClick={onRefresh}
            title="Refresh options"
          >
            <RefreshCw className="w-3 h-3" />
          </button>
          <button
            className="p-1 rounded hover:bg-secondary text-slate-500 hover:text-red-400 transition-colors"
            onClick={onDelete}
            title="Remove from scanner"
          >
            <X className="w-3 h-3" />
          </button>
        </div>
        {expanded
          ? <ChevronDown className="w-4 h-4 text-slate-400 shrink-0" />
          : <ChevronRight className="w-4 h-4 text-slate-500 shrink-0" />
        }
      </div>

      {/* Expanded panel */}
      {expanded && (
        <div
          className="px-4 pb-4 pt-1 space-y-3 bg-secondary/10"
          style={{ borderLeft: `4px solid ${borderColor}` }}
        >
          {/* Reasoning line */}
          {indicator && (
            <p className="text-xs text-muted-foreground">
              {buildReasoning(indicator, firstIV, macroRegime)}
            </p>
          )}

          {/* Strike cards */}
          {optionsLoading && (
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <Loader2 className="w-3 h-3 animate-spin" />
              Loading options…
            </div>
          )}

          {!optionsLoading && optionsData && strikes.length > 0 && (() => {
            // Group strikes by expiry, preserving chronological chain order
            const byExpiry = new Map<string, { chain: OptionsChainResult; puts: Array<{ put: OptionRow; weeklyIncome: number }> }>();
            for (const { chain, put, weeklyIncome } of strikes) {
              if (!byExpiry.has(chain.expiry)) byExpiry.set(chain.expiry, { chain, puts: [] });
              byExpiry.get(chain.expiry)!.puts.push({ put, weeklyIncome });
            }
            // Sort each expiry's puts by strike descending (highest first)
            for (const group of byExpiry.values()) {
              group.puts.sort((a, b) => b.put.strike - a.put.strike);
            }
            return (
              <div className="space-y-2">
                {Array.from(byExpiry.values()).map(({ chain, puts }) => (
                  <ExpirySection
                    key={chain.expiry}
                    chain={chain}
                    puts={puts}
                    bestStrike={bestStrike}
                    newScorerBest={newScorerBest}
                    stockCtx={stockCtx}
                    macroRegime={macroRegime}
                    allWatchlistIVs={allWatchlistIVs}
                  />
                ))}
              </div>
            );
          })()}

          {!optionsLoading && optionsData && strikes.length === 0 && (
            <div className="space-y-2">
              <p className="text-xs text-muted-foreground italic">
                {strikeSummary(optionsData, show1wk, show2wk)}
              </p>
              {canOverride && !overrideEnabled && (
                <button
                  onClick={e => { e.stopPropagation(); onOverride(); }}
                  className="text-xs px-2.5 py-1 rounded border border-amber-500/40 text-amber-400 hover:bg-amber-500/10 transition-colors"
                >
                  Override — show best put anyway
                </button>
              )}
              {overrideEnabled && overrideBest && (
                <div className="space-y-1.5">
                  <p className="text-[11px] text-red-400/80 italic">Overridden — recommendation below does not meet normal criteria</p>
                  <div className="rounded-md border border-border/60 overflow-hidden">
                    <StrikeTableHeader />
                    <StrikeRow
                      chain={overrideBest.chain}
                      put={overrideBest.put}
                      isBest
                    />
                  </div>
                </div>
              )}
              {overrideEnabled && overrideStrikes.length === 0 && (
                <p className="text-xs text-red-400/70 italic">No puts available even without income filter.</p>
              )}
            </div>
          )}

          {!optionsLoading && !optionsData && (
            <p className="text-xs text-muted-foreground italic">No options data.</p>
          )}
        </div>
      )}
    </div>
  );
}

// ── MacroBanner ───────────────────────────────────────────────────────────────

function MacroBanner({ data }: { data: MacroRegimeResult | undefined }) {
  if (!data || data.vix == null) return null;
  const regimeStyle =
    data.regime === "LOW_VOL"  ? "text-blue-400 border-blue-500/30 bg-blue-500/5" :
    data.regime === "ELEVATED" ? "text-orange-400 border-orange-500/30 bg-orange-500/5" :
    data.regime === "EXTREME"  ? "text-red-400 border-red-500/30 bg-red-500/5" :
                                  "text-muted-foreground border-border bg-card/50";
  const dirIcon =
    data.indexDirection === "RALLY" ? "▲" :
    data.indexDirection === "CRASH" ? "▼" : "–";
  const target = REGIME_INCOME_TARGET[data.regime];
  const floor  = REGIME_INCOME_FLOOR[data.regime];
  return (
    <div className={cn("flex items-center gap-3 px-3 py-1.5 rounded-md border text-xs", regimeStyle)}>
      <span className="font-semibold tracking-wide">{data.regime.replace("_", " ")}</span>
      <span>VIX {data.vix.toFixed(1)}</span>
      <span>{dirIcon} {data.indexDirection}</span>
      <span className="text-muted-foreground">income target {floor === target ? `${target}%` : `${floor}–${target}%`}/wk</span>
    </div>
  );
}

// ── Main Page ─────────────────────────────────────────────────────────────────

export default function OptionsScanner() {
  const queryClient = useQueryClient();

  const [expandedSet,   setExpandedSet]   = useState<Set<string>>(new Set());
  const [fetchedOnce,   setFetchedOnce]   = useState<Set<string>>(new Set());
  const [overrides,     setOverrides]     = useState<Set<string>>(new Set());
  const [sort,          setSort]          = useState<SortKey>("score");
  const [show1wk,       setShow1wk]       = useState(true);
  const [show2wk,       setShow2wk]       = useState(true);
  const [goOnly,        setGoOnly]        = useState(false);
  const [minIncomeOn,   setMinIncomeOn]   = useState(true);
  const [refreshedAt,   setRefreshedAt]   = useState(() => new Date());
  const [extraTickers,  setExtraTickers]  = useState<string[]>(() => {
    try { const s = localStorage.getItem("fildi_scanner_extra"); return s ? JSON.parse(s) : []; } catch { return []; }
  });
  const [hiddenTickers, setHiddenTickers] = useState<Set<string>>(() => {
    try { const s = localStorage.getItem("fildi_scanner_hidden"); return s ? new Set(JSON.parse(s)) : new Set(); } catch { return new Set(); }
  });
  const [addInput,      setAddInput]      = useState("");

  useEffect(() => { localStorage.setItem("fildi_scanner_extra",  JSON.stringify(extraTickers)); }, [extraTickers]);
  useEffect(() => { localStorage.setItem("fildi_scanner_hidden", JSON.stringify([...hiddenTickers])); }, [hiddenTickers]);

  const { entries, isLoaded } = useWatchlist();

  const activeTickers = useMemo(
    () => entries.filter(e => e.colorTag !== RED_TAG).map(e => e.ticker),
    [entries],
  );
  const colorMap = useMemo(
    () => new Map(entries.map(e => [e.ticker, e.colorTag])),
    [entries],
  );

  // Watchlist tickers minus hidden, plus user-added extras
  const displayTickers = useMemo(() => {
    const base  = activeTickers.filter(t => !hiddenTickers.has(t));
    const extra = extraTickers.filter(t => !hiddenTickers.has(t));
    return [...base, ...extra];
  }, [activeTickers, extraTickers, hiddenTickers]);

  // ── V2 technicals — all 31 rows for self-relative scoring ───────────────────
  const { data: allTechnicalsData } = useQuery({
    queryKey: ["technicals", "all"],
    queryFn: async (): Promise<TechnicalRow[]> => {
      const res = await fetch("/api/technicals/all");
      if (!res.ok) throw new Error("technicals/all fetch failed");
      return res.json();
    },
    staleTime: Infinity,
    refetchOnWindowFocus: false,
  });

  // ── Scorecard batch — watchlist tickers (for display: RSI, MFI, IV, price) ─
  const { data: scorecardData, isLoading: scorecardLoading, refetch: refetchScorecard } = useQuery({
    queryKey:             ["technical-scorecard"],
    queryFn:              async () => {
      const res = await fetch("/api/technical/scorecard");
      if (!res.ok) throw new Error("scorecard fetch failed");
      return res.json() as Promise<ScorecardRow[]>;
    },
    staleTime:            Infinity,
    refetchOnWindowFocus: false,
  });

  // ── Individual indicator queries for extra tickers ───────────────────────────
  const extraIndicatorQueries = useQueries({
    queries: extraTickers.map(ticker => ({
      queryKey:             ["indicators", ticker],
      queryFn:              async () => {
        const res = await fetch(`/api/indicators/${ticker}`);
        if (!res.ok) throw new Error(`indicator fetch failed: ${ticker}`);
        return res.json() as Promise<ScorecardRow>;
      },
      staleTime:            Infinity,
      refetchOnWindowFocus: false,
    })),
  });

  // ── Per-ticker options — enabled only after first expand ────────────────────
  const optionsQueries = useQueries({
    queries: displayTickers.map(ticker => ({
      queryKey:             ["options", ticker],
      queryFn:              async () => {
        const res = await fetch(`/api/options/${ticker}`);
        if (!res.ok) throw new Error(`options fetch failed: ${ticker}`);
        return res.json() as Promise<OptionsChainResult[]>;
      },
      enabled:              fetchedOnce.has(ticker),
      staleTime:            5 * 60_000,
      refetchOnWindowFocus: false,
    })),
  });

  // ── Derived maps ─────────────────────────────────────────────────────────────
  const scorecardMap = useMemo(() => {
    const m = new Map((scorecardData ?? []).map(r => [r.ticker, r]));
    extraTickers.forEach((t, i) => {
      const d = extraIndicatorQueries[i]?.data;
      if (d) m.set(t, d);
    });
    return m;
  }, [scorecardData, extraTickers, extraIndicatorQueries]);

  const optionsMap = useMemo(() => {
    const m = new Map<string, OptionsChainResult[] | null>();
    displayTickers.forEach((t, i) => m.set(t, optionsQueries[i]?.data ?? null));
    return m;
  }, [displayTickers, optionsQueries]);

  const optionsLoadingMap = useMemo(() => {
    const m = new Map<string, boolean>();
    displayTickers.forEach((t, i) => m.set(t, optionsQueries[i]?.isFetching ?? false));
    return m;
  }, [displayTickers, optionsQueries]);

  // ── Macro regime — for Option Scorer overlay ─────────────────────────────────
  const { data: macroRegimeData } = useQuery({
    queryKey: ["macro", "regime"],
    queryFn: async (): Promise<MacroRegimeResult> => {
      const res = await fetch("/api/macro/regime");
      if (!res.ok) return { vix: null, spxChange1d: null, ndxChange1d: null, rutChange1d: null, regime: "BASELINE", indexDirection: "NEUTRAL", error: "fetch failed" };
      return res.json();
    },
    staleTime: 5 * 60_000,
    refetchOnWindowFocus: false,
  });

  // ── Fundamental rankings — for Option Scorer stock quality component ──────────
  const { data: fundRankingsData } = useQuery({
    queryKey: ["fundamentals", "rankings"],
    queryFn: async (): Promise<Array<{ ticker: string; totalScore: number }>> => {
      const res = await fetch("/api/fundamentals/rankings");
      if (!res.ok) throw new Error("fundamentals/rankings failed");
      return res.json();
    },
    staleTime: Infinity,
    refetchOnWindowFocus: false,
  });

  // V2: self-relative scores over all 31 watchlist rows — invariant to display filter
  const rankings = useMemo(() => {
    if (!allTechnicalsData?.length) return new Map<string, TechnicalScore>();
    return new Map(computeTechnicalRankingsV2(allTechnicalsData).map(s => [s.ticker, s]));
  }, [allTechnicalsData]);

  // Tech row map (full fields for Option Scorer — includes swingLow, pivotS1, atr14, etc.)
  const techRowMap = useMemo(
    () => new Map((allTechnicalsData ?? []).map(r => [r.ticker, r])),
    [allTechnicalsData],
  );

  // Fundamental score map
  const fundScoreMap = useMemo(
    () => new Map((fundRankingsData ?? []).map(r => [r.ticker, r.totalScore])),
    [fundRankingsData],
  );

  // Cross-watchlist IVs for absolute IV component (from all loaded option chains)
  const allWatchlistIVs = useMemo(() => {
    const ivs: number[] = [];
    for (const chains of optionsMap.values()) {
      if (!chains) continue;
      for (const c of chains) for (const p of c.puts) if (p.iv > 0) ivs.push(p.iv);
    }
    return ivs;
  }, [optionsMap]);

  // Best option score per ticker (drives optionScore sort + stockScoreMap)
  const bestOptionScoreMap = useMemo(() => {
    const m = new Map<string, number>();
    for (const ticker of displayTickers) {
      const chains = optionsMap.get(ticker);
      const techRow = techRowMap.get(ticker);
      if (!chains || !techRow) continue;
      const stockCtx: StockContext = {
        ivRank:                pfNum(techRow.ivRank),
        ivPercentile:          pfNum(techRow.ivPercentile),
        ivVsRealizedVol:       pfNum(techRow.ivVsRealizedVol),
        basicSkew:             pfNum(techRow.basicSkew),
        swingLow20d:           pfNum(techRow.swingLow20d),
        swingLow50d:           pfNum(techRow.swingLow50d),
        pivotS1:               pfNum(techRow.pivotS1),
        nearestSupportDistPct: pfNum(techRow.nearestSupportDistPct),
        techTotalScore:        rankings.get(ticker)?.totalScore ?? null,
        fundTotalScore:        fundScoreMap.get(ticker) ?? null,
      };
      const picked = pickBestStrike(chains, stockCtx, macroRegimeData?.regime ?? "BASELINE", allWatchlistIVs);
      if (picked) m.set(ticker, picked.result.optionScore);
    }
    return m;
  }, [displayTickers, optionsMap, techRowMap, rankings, fundScoreMap, macroRegimeData, allWatchlistIVs]);

  // Stock Score per ticker (drives "Stock Score" sort — combines tech + fund + relMove + bestOption + tag)
  const stockScoreMap = useMemo(() => {
    const m = new Map<string, number>();
    for (const ticker of displayTickers) {
      const techRow   = techRowMap.get(ticker);
      const indicator = scorecardMap.get(ticker);
      const chains    = optionsMap.get(ticker);
      const relMove   = computeRelativeMove(
        pfNum(techRow?.priceZScore),
        pfNum(techRow?.priceVsMa50Atr),
        indicator?.return5d ?? null,
        pfNum(techRow?.swingHigh20d),
        pfNum(techRow?.swingLow20d),
        chains?.[0]?.spot ?? null,
      );
      const result = computeStockScore({
        techTotalScore:    rankings.get(ticker)?.totalScore ?? null,
        fundTotalScore:    fundScoreMap.get(ticker) ?? null,
        relativeMoveScore: relMove,
        bestOptionScore:   bestOptionScoreMap.get(ticker) ?? null,
        colorTag:          colorMap.get(ticker) ?? null,
      });
      m.set(ticker, result.stockScore);
    }
    return m;
  }, [displayTickers, techRowMap, scorecardMap, optionsMap, rankings, fundScoreMap, bestOptionScoreMap, colorMap]);

  // ── Sort + filter ─────────────────────────────────────────────────────────────
  const sortedTickers = useMemo(() => {
    let list = [...displayTickers];
    if (goOnly) list = list.filter(t => rankings.get(t)?.signal === "GO");

    list.sort((a, b) => {
      switch (sort) {
        case "optionScore":
          return (bestOptionScoreMap.get(b) ?? -1) - (bestOptionScoreMap.get(a) ?? -1);
        case "score":
          return (stockScoreMap.get(b) ?? 0) - (stockScoreMap.get(a) ?? 0);
        case "signal": {
          const o = { GO: 2, WATCH: 1, NO: 0 } as const;
          return (o[rankings.get(b)?.signal ?? "NO"] ?? 0) - (o[rankings.get(a)?.signal ?? "NO"] ?? 0);
        }
        case "iv": {
          const iv = (t: string) => scorecardMap.get(t)?.ivCurrent ?? -1;
          return iv(b) - iv(a);
        }
        case "buffer": {
          const buf = (t: string) => {
            const chains = optionsMap.get(t);
            if (!chains) return -1;
            const spot = chains[0]?.spot ?? 0;
            if (!spot) return -1;
            let best = -1;
            for (const c of chains) {
              const exactDte = c.exactDte ?? Math.max(1, c.daysToExpiry);
              for (const p of c.puts) {
                if (p.iv <= 0 || exactDte <= 0) continue;
                const otm = (spot - p.strike) / spot;
                const sds = otm / (p.iv * Math.sqrt(exactDte / 365));
                if (sds > best) best = sds;
              }
            }
            return best;
          };
          return buf(b) - buf(a);
        }
        case "otm": {
          const otm = (t: string) => {
            const chains = optionsMap.get(t);
            if (!chains) return -1;
            const spot = chains[0]?.spot ?? 0;
            const best = Math.max(...chains.flatMap(c => c.puts.filter(p => p.meetsGate).map(p => p.strike)), 0);
            return spot > 0 && best > 0 ? ((spot - best) / spot) * 100 : -1;
          };
          return otm(b) - otm(a);
        }
        case "income":
        default: {
          const income = (t: string) => {
            const chains = optionsMap.get(t);
            if (!chains) return -1;
            let best = -1;
            for (const c of chains) {
              const exactDte = Math.max(0.01, c.exactDte ?? c.daysToExpiry);
              for (const p of c.puts) {
                const wi = p.incomePct / (exactDte / 7);
                if (wi > best) best = wi;
              }
            }
            return best;
          };
          return income(b) - income(a);
        }
      }
    });
    return list;
  }, [displayTickers, sort, goOnly, scorecardMap, rankings, optionsMap, bestOptionScoreMap, stockScoreMap]);

  // ── Handlers ──────────────────────────────────────────────────────────────────
  const handleExpand = (ticker: string) => {
    setExpandedSet(prev => {
      const next = new Set(prev);
      next.has(ticker) ? next.delete(ticker) : next.add(ticker);
      return next;
    });
    setFetchedOnce(prev => prev.has(ticker) ? prev : new Set([...prev, ticker]));
  };

  const handleRowRefresh = (ticker: string) => {
    setFetchedOnce(prev => new Set([...prev, ticker]));
    queryClient.invalidateQueries({ queryKey: ["options", ticker] });
  };

  const handleOverride = (ticker: string) => {
    setFetchedOnce(prev => new Set([...prev, ticker]));
    setOverrides(prev => new Set([...prev, ticker]));
  };

  const handleDelete = (ticker: string) => {
    setHiddenTickers(prev => new Set([...prev, ticker]));
    setExtraTickers(prev => prev.filter(t => t !== ticker));
    setExpandedSet(prev => { const n = new Set(prev); n.delete(ticker); return n; });
    setOverrides(prev => { const n = new Set(prev); n.delete(ticker); return n; });
  };

  const handleAdd = () => {
    const t = addInput.trim().toUpperCase();
    if (!t || displayTickers.includes(t)) { setAddInput(""); return; }
    setExtraTickers(prev => [...prev, t]);
    setAddInput("");
  };

  const handleGlobalRefresh = () => {
    refetchScorecard();
    setRefreshedAt(new Date());
  };

  // ── Render ────────────────────────────────────────────────────────────────────
  const nonRedColors = PRESET_COLORS.filter(c => c !== RED_TAG);

  return (
    <div className="flex min-h-screen bg-background">
      <Sidebar />
      <main className="flex-1 ml-[220px] p-6 space-y-4">

        {/* Header */}
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-xl font-bold">Options Scanner</h1>
            <div className="flex items-center gap-3 mt-1">
              {nonRedColors.map(c => (
                <span key={c} className="flex items-center gap-1 text-[11px] text-muted-foreground">
                  <span className="w-2.5 h-2.5 rounded-sm inline-block" style={{ background: c }} />
                </span>
              ))}
              <span className="flex items-center gap-1 text-[11px] text-muted-foreground">
                <span className="w-2.5 h-2.5 rounded-sm inline-block" style={{ background: RED_TAG }} />
                excluded
              </span>
            </div>
          </div>
          <button
            className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors"
            onClick={handleGlobalRefresh}
            disabled={scorecardLoading}
          >
            {scorecardLoading
              ? <Loader2 className="w-3.5 h-3.5 animate-spin" />
              : <RefreshCw className="w-3.5 h-3.5" />
            }
            {minutesAgo(refreshedAt)}
          </button>
        </div>

        <MacroBanner data={macroRegimeData} />

        {/* Controls */}
        <div className="flex items-center gap-2 flex-wrap">
          {/* Sort buttons */}
          <div className="flex items-center gap-1 border border-border rounded-md p-0.5">
            {SORT_LABELS.map(({ key, label }) => (
              <button
                key={key}
                onClick={() => setSort(key)}
                className={cn(
                  "px-2.5 py-1 text-xs rounded transition-colors",
                  sort === key
                    ? "bg-primary text-primary-foreground"
                    : "text-muted-foreground hover:text-foreground",
                )}
              >
                {label}
              </button>
            ))}
          </div>

          <div className="w-px h-5 bg-border mx-1" />

          {/* Filter chips */}
          {(
            [
              { label: "1wk", on: show1wk, toggle: () => setShow1wk(v => !v) },
              { label: "2wk", on: show2wk, toggle: () => setShow2wk(v => !v) },
              { label: "GO only", on: goOnly, toggle: () => setGoOnly(v => !v) },
              { label: "≥0.5%/wk", on: minIncomeOn, toggle: () => setMinIncomeOn(v => !v) },
            ] as const
          ).map(({ label, on, toggle }) => (
            <button
              key={label}
              onClick={toggle}
              className={cn(
                "px-2.5 py-1 text-xs rounded-md border transition-colors",
                on
                  ? "border-primary/50 bg-primary/10 text-primary"
                  : "border-border text-muted-foreground hover:text-foreground",
              )}
            >
              {label}
            </button>
          ))}

          <div className="w-px h-5 bg-border mx-1" />

          {/* Add ticker input */}
          <div className="flex items-center gap-1">
            <input
              type="text"
              value={addInput}
              onChange={e => setAddInput(e.target.value.toUpperCase())}
              onKeyDown={e => e.key === "Enter" && handleAdd()}
              placeholder="Add ticker…"
              className="h-7 w-28 px-2 text-xs rounded-md border border-border bg-background text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-primary"
            />
            <button
              onClick={handleAdd}
              disabled={!addInput.trim()}
              className="h-7 w-7 flex items-center justify-center rounded-md border border-border text-muted-foreground hover:text-foreground hover:border-primary/50 disabled:opacity-40 transition-colors"
            >
              <Plus className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>

        {/* Scanner table */}
        {scorecardLoading || !isLoaded ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground py-8 justify-center">
            <Loader2 className="w-4 h-4 animate-spin" />
            Loading scorecard…
          </div>
        ) : sortedTickers.length === 0 ? (
          <div className="text-sm text-muted-foreground py-8 text-center">
            No tickers match current filters.
          </div>
        ) : (
          <div className="rounded-md border border-border overflow-hidden">
            {sortedTickers.map(ticker => (
              <ScannerRow
                key={ticker}
                ticker={ticker}
                colorTag={colorMap.get(ticker) ?? ""}
                indicator={scorecardMap.get(ticker) ?? null}
                score={rankings.get(ticker) ?? null}
                optionsData={optionsMap.get(ticker) ?? null}
                optionsLoading={optionsLoadingMap.get(ticker) ?? false}
                expanded={expandedSet.has(ticker)}
                show1wk={show1wk}
                show2wk={show2wk}
                minIncomeOn={minIncomeOn}
                overrideEnabled={overrides.has(ticker)}
                onExpand={() => handleExpand(ticker)}
                onRefresh={() => handleRowRefresh(ticker)}
                onDelete={() => handleDelete(ticker)}
                onOverride={() => handleOverride(ticker)}
                techRow={techRowMap.get(ticker) ?? null}
                fundTotalScore={fundScoreMap.get(ticker) ?? null}
                macroRegime={macroRegimeData?.regime ?? "BASELINE"}
                allWatchlistIVs={allWatchlistIVs}
              />
            ))}
          </div>
        )}
      </main>
    </div>
  );
}
