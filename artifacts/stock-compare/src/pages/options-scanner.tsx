import { useState, useMemo, useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { TopNav } from "@/components/top-nav";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { useWatchlist, PRESET_COLORS } from "@/hooks/use-watchlist";
import {
  computeTechnicalRankingsV2,
  type TechnicalRow,
  type IndicatorResult,
  type TechnicalScore,
} from "@/lib/technical-rankings";
import { ChevronDown, ChevronRight, RefreshCw, Loader2, X, Sparkles } from "lucide-react";
import { pickBestStrike, computeOptionScore, buildCandidate, type StockContext, type OptionScoreResult } from "@/lib/option-scorer";
import { computeRelativeMove, computeStockScore } from "@/lib/stock-scorer";
import { useScoringPreferences } from "@/context/ScoringPreferencesContext";
import { type MacroRegime, REGIME_INCOME_TARGET, REGIME_INCOME_FLOOR } from "@/lib/option-scorer-constants";
import { StrikeDetailPanel } from "@/components/strike-detail-panel";
import { useAuth } from "@/context/AuthContext";
import { queryKeys } from "@/lib/query-keys";
import { getTraderPrefs, saveTraderPrefs } from "@/lib/trader-prefs";

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
  bidIsLive: boolean;
  delta: number | null;
  spreadPct: number | null;
}

interface OptionsChainResult {
  ticker: string;
  expiry: string;
  isWeekly: boolean;
  daysToExpiry: number;
  exactDte: number;
  settlementDte: number;
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
type SortKey = "optionScore" | "score" | "income" | "iv" | "otm" | "buffer";

function pfNum(v: number | string | null | undefined): number | null {
  if (v == null) return null;
  const n = typeof v === "number" ? v : parseFloat(v as string);
  return Number.isFinite(n) ? n : null;
}

// ── Constants ─────────────────────────────────────────────────────────────────

const RED_TAG = "#ef4444";

function SortableHeader({ label, sortKey, active, width, onClick }: {
  label: string;
  sortKey: SortKey;
  active: boolean;
  width: string;
  onClick: (key: SortKey) => void;
}) {
  return (
    <button
      onClick={() => onClick(sortKey)}
      className={cn(
        `${width} shrink-0 text-left transition-colors`,
        active ? "text-primary" : "text-white hover:text-white/80",
      )}
    >
      {label}{active ? " ▾" : ""}
    </button>
  );
}

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
): Array<{ chain: OptionsChainResult; put: OptionRow; weeklyIncome: number }> {
  return chains
    .filter(c => (show1wk && Math.ceil(c.daysToExpiry / 7) === 1) ||
                 Math.ceil(c.daysToExpiry / 7) >= 2)
    .flatMap(c => {
      const settlementDte = c.settlementDte ?? c.exactDte ?? Math.max(1, c.daysToExpiry);
      return c.puts
        .map(p => ({ chain: c, put: p, weeklyIncome: p.incomePct / (settlementDte / 7) }))
        .filter(x => x.weeklyIncome >= minWeeklyIncome);
    });
}

function strikeSummary(
  chains: OptionsChainResult[] | null,
  show1wk: boolean,
  minWeeklyIncome: number,
): string {
  if (!chains) return "—";
  const strikes = viableStrikes(chains, minWeeklyIncome, show1wk);
  if (strikes.length === 0) return "no viable strikes";
  const best = Math.max(...strikes.map(s => s.weeklyIncome));
  return `${strikes.length} strike${strikes.length !== 1 ? "s" : ""} · best ${best.toFixed(2)}%/wk`;
}

// RSI thresholds are per-ticker, calibrated from historical win rate by tier — not a
// universal constant. Shown alongside the threshold so "35" reads as a calibrated value,
// not an arbitrary hardcode. See RSI_THRESHOLDS / TIER_MAP in api-server/src/lib/constants.ts.
const TIER_WIN_RATE: Record<1 | 2 | 3, string> = {
  1: "≥92%",
  2: "≥94%",
  3: "≥97%",
};

function buildReasoning(d: ScorecardRow, firstIV: number | null, macroRegime: MacroRegime = "BASELINE"): string {
  const tierPart = ` (Tier ${d.tier}, ${TIER_WIN_RATE[d.tier]} win rate)`;
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
    return `RSI ${d.rsi.toFixed(1)} near threshold ${d.rsiThreshold}${tierPart} — monitor`;
  }
  if (!d.rsiOk) return `RSI ${d.rsi.toFixed(1)} above threshold ${d.rsiThreshold}${tierPart}`;
  if (!d.mfiOk) return `MFI ${d.mfi.toFixed(1)} above 25`;
  if (d.return5d != null && d.return5d > 5) return `Up +${d.return5d.toFixed(1)}% in 5d — entry score reduced`;
  return "conditions not met";
}

// ── Sub-components ────────────────────────────────────────────────────────────

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

// ── Strike row (one put per expiry table row) ─────────────────────────────────

function StrikeRow({
  chain,
  put,
  isBest,
  optionScore,
  dataQuality,
  scoreResult,
  runnerUp,
}: {
  chain: OptionsChainResult;
  put: OptionRow;
  isBest: boolean;
  optionScore?: number | null;
  dataQuality?: number | null;
  scoreResult?: OptionScoreResult | null;
  runnerUp?: { chain: OptionsChainResult; put: OptionRow; result: OptionScoreResult } | null;
}) {
  const [expanded, setExpanded] = useState(false);
  const exactDte      = chain.exactDte ?? Math.max(1, chain.daysToExpiry);
  const settlementDte = chain.settlementDte ?? exactDte;
  const weeklyIncome  = put.incomePct / (settlementDte / 7);
  const otmPct       = ((chain.spot - put.strike) / chain.spot) * 100;
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
    <div>
      <div
        className={cn(
          "grid items-center gap-x-4 px-3 py-1 text-xs border-l-2 transition-colors cursor-pointer select-none",
          "grid-cols-[80px_56px_72px_60px_52px_52px_60px_48px_1fr]",
          isBest
            ? "border-l-yellow-400 bg-yellow-400/10 hover:bg-yellow-400/15 ring-1 ring-inset ring-yellow-400/20"
            : gammaRisk
              ? "border-l-orange-500/60 hover:bg-secondary/30"
              : "border-l-transparent hover:bg-secondary/30",
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
        {/* Bid — dimmed with "~" prefix when using lastPrice fallback (market closed) */}
        <div className={cn("font-mono", put.bidIsLive ? "text-white" : "text-white")}
          title={put.bidIsLive ? undefined : "Market closed — showing last traded price"}>
          {put.bidIsLive ? "" : "~"}${(put.bid > 0 ? put.bid : put.lastPrice).toFixed(2)}
        </div>
        {/* %/wk */}
        <div
          className={cn("font-mono font-semibold", incomeColor)}
          title={
            `%/wk = (Bid ÷ Strike × 100) ÷ (Days until settlement ÷ 7)\n` +
            `= ($${(put.bid > 0 ? put.bid : put.lastPrice).toFixed(2)} ÷ $${put.strike}) × 100 ÷ (${settlementDte.toFixed(1)} ÷ 7)\n` +
            `= ${put.incomePct.toFixed(3)}% total premium ÷ ${(settlementDte / 7).toFixed(2)} wks until settlement\n` +
            `= ${weeklyIncome.toFixed(2)}%/wk\n\n` +
            `Settlement days = ${exactDte.toFixed(1)} days to expiry + ${(settlementDte - exactDte).toFixed(0)}d settlement lag ` +
            `(options settle T+1 business day — e.g. Friday expiry → Monday)`
          }
        >
          {weeklyIncome.toFixed(2)}%
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
      {expanded && (
        <StrikeDetailPanel
          put={put}
          chain={chain}
          scoreResult={scoreResult ?? null}
          isBest={isBest}
          runnerUp={isBest ? (runnerUp ?? null) : null}
        />
      )}
    </div>
  );
}

// ── Column header for the strike table ───────────────────────────────────────

function StrikeTableHeader() {
  return (
    <div className={cn(
      "grid items-center gap-x-4 px-3 py-1 text-[10px] font-semibold tracking-wider uppercase",
      "grid-cols-[80px_56px_72px_60px_52px_52px_60px_48px_1fr]",
      "border-b border-border/60 bg-slate-900/60 text-white",
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
  strikeWeights,
  defaultCollapsed = false,
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
}) {
  const [collapsed, setCollapsed] = useState(defaultCollapsed);

  const hasBestStrike = bestStrike != null && bestStrike.chain.expiry === chain.expiry;
  const bestInExpiry  = puts.reduce((a, b) => a.weeklyIncome > b.weeklyIncome ? a : b, puts[0]);

  // Compute full OptionScoreResult for every put in this expiry
  const scoreResults = useMemo(() => {
    if (!stockCtx) return new Map<number, OptionScoreResult>();
    const map = new Map<number, OptionScoreResult>();
    for (const { put } of puts) {
      const candidate = buildCandidate(put, chain);
      map.set(put.strike, computeOptionScore(candidate, stockCtx, macroRegime, allWatchlistIVs, strikeWeights));
    }
    return map;
  }, [puts, chain, stockCtx, macroRegime, allWatchlistIVs, strikeWeights]);

  return (
    <div className="rounded-md border border-border/60 overflow-hidden">
      {/* Expiry group header */}
      <button
        className={cn(
          "w-full flex items-center gap-2 px-3 py-1 text-left transition-colors",
          "hover:bg-secondary/40 bg-secondary/20",
        )}
        onClick={() => setCollapsed(c => !c)}
      >
        {collapsed
          ? <ChevronRight className="w-3.5 h-3.5 text-white shrink-0" />
          : <ChevronDown className="w-3.5 h-3.5 text-white shrink-0" />
        }
        <span className="text-xs font-medium text-foreground">
          {formatExpiry(chain.expiry, chain.daysToExpiry)}
        </span>
        <span className="text-xs text-white">
          {puts.length} strike{puts.length !== 1 ? "s" : ""}
          {bestInExpiry ? ` · best ${bestInExpiry.weeklyIncome.toFixed(2)}%/wk` : ""}
        </span>
        {hasBestStrike && (
          <span className="ml-auto text-[10px] font-semibold text-yellow-300 bg-yellow-400/15 border border-yellow-400/30 rounded px-1.5 py-0.5 uppercase tracking-wide">
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
                runnerUp={isBest ? (newScorerBest?.runnerUp ?? null) : null}
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
}: ScannerRowProps) {
  const signal    = indicator?.signal ?? "NO";
  const price     = optionsData?.[0]?.spot ?? indicator?.price ?? null;
  const firstIV   = optionsData?.[0]?.puts?.[0]?.iv ?? null;

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
    ? viableStrikes(optionsData, minIncome, show1wk)
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
    const picked = pickBestStrike(optionsData, stockCtx, macroRegime, allWatchlistIVs, undefined, strikeWeights);
    if (!picked) return null;
    return {
      chain: picked.chain as OptionsChainResult,
      put: picked.put as OptionRow,
      weeklyIncome: picked.result.weeklyIncome,
      optionScore: picked.result.optionScore,
      dataQuality: picked.result.dataQuality,
      runnerUp: picked.runnerUp as { chain: OptionsChainResult; put: OptionRow; result: OptionScoreResult } | null,
    };
  }, [optionsData, stockCtx, macroRegime, allWatchlistIVs, strikeWeights]);

  const bestStrike = newScorerBest
    ?? (strikes.length > 0 ? strikes.reduce((a, b) => a.weeklyIncome > b.weeklyIncome ? a : b) : null);

  // Override: show best put even when no viable strikes at current minIncome threshold
  const canOverride = strikes.length === 0 && optionsData !== null && !optionsLoading;
  const overrideStrikes = overrideEnabled && optionsData
    ? viableStrikes(optionsData, 0, show1wk)
    : [];
  const overrideBest = overrideStrikes.length > 0
    ? overrideStrikes.reduce((a, b) => a.weeklyIncome > b.weeklyIncome ? a : b)
    : null;

  // Prefer ivCurrent from scorecard (always loaded); fall back to options chain iv
  const ivPct = indicator?.ivCurrent && indicator.ivCurrent > 0
    ? indicator.ivCurrent.toFixed(0)
    : firstIV != null ? (firstIV * 100).toFixed(0) : null;
  const ivDisplay = ivPct != null ? `IV ${ivPct}%` : "IV —";

  const summary = optionsLoading ? null : strikeSummary(optionsData, show1wk, minIncome);

  const borderColor = colorTag || "transparent";

  return (
    <div className="border-b border-border last:border-b-0">
      {/* Collapsed header row */}
      <div
        className="flex items-center gap-3 px-4 py-1.5 cursor-pointer hover:bg-secondary/30 transition-colors select-none"
        style={{ borderLeft: `4px solid ${borderColor}` }}
        onClick={onExpand}
      >
        {/* Ticker */}
        <div className="w-[70px] shrink-0">
          <span
            className="font-bold text-xs tracking-wide"
            style={{ color: overrideEnabled ? "#f87171" : (colorTag || undefined) }}
          >
            {ticker}
          </span>
        </div>

        {/* Price */}
        <div className="w-[80px] shrink-0">
          {price != null && (
            <span className="text-xs font-mono font-semibold text-cyan-400">${price.toFixed(2)}</span>
          )}
        </div>

        <div className="w-[56px] shrink-0">
          <SignalBadge signal={signal} />
        </div>

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

        {/* Strike summary */}
        <span className={cn(
          "text-xs flex-1",
          summary?.startsWith("excluded") ? "text-white italic" :
          summary?.startsWith("no viable") ? "text-white" : "text-white",
        )}>
          {optionsLoading ? (
            <Loader2 className="w-3 h-3 animate-spin inline" />
          ) : (summary ?? "—")}
        </span>

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
          className="px-4 pb-2 pt-1 space-y-1.5 bg-slate-950/70"
          style={{ borderLeft: `4px solid ${borderColor}` }}
        >
          {/* Reasoning line — deterministic text always shown; AI context (outlier moves,
              sector flow, news) is opt-in via the button below since it costs an API call. */}
          {indicator && (
            <p className="text-xs text-white">
              {buildReasoning(indicator, firstIV, macroRegime)}
            </p>
          )}

          {indicator && (
            aiReasoning ? (
              <p className="text-xs text-primary/90 leading-snug border-l-2 border-primary/30 pl-2 py-0.5">
                {aiReasoning}
              </p>
            ) : (
              <button
                onClick={() => setAiRequested(true)}
                disabled={reasoningLoading}
                className="flex items-center gap-1.5 text-[11px] text-primary hover:text-primary/80 disabled:opacity-60 disabled:cursor-default transition-colors"
              >
                {reasoningLoading
                  ? <Loader2 className="w-3 h-3 animate-spin" />
                  : <Sparkles className="w-3 h-3" />}
                {reasoningLoading ? "Getting AI context…" : "Get AI context"}
              </button>
            )
          )}
          {reasoningError && (
            <p className="text-[11px] text-destructive/80">Couldn't get AI context — try again later.</p>
          )}

          {/* Strike cards */}
          {optionsLoading && (
            <div className="flex items-center gap-2 text-xs text-white">
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
                    strikeWeights={strikeWeights}
                    defaultCollapsed={idx > 0}
                  />
                ))}
              </div>
            );
          })()}

          {!optionsLoading && optionsData && strikes.length === 0 && (
            <div className="space-y-2">
              <p className="text-xs text-white italic">
                {strikeSummary(optionsData, show1wk, minIncome)}
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
            <p className="text-xs text-white italic">No options data.</p>
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
                                  "text-white border-border bg-card/50";
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
      <span className="text-white">income target {floor === target ? `${target}%` : `${floor}–${target}%`}/wk</span>
    </div>
  );
}

// Scoped per user so multiple accounts on the same browser don't inherit each
// other's hidden scanner tickers (mirrors colorKey in use-watchlist.ts)
function scannerHiddenKey(userId: number | undefined): string {
  return userId ? `fildi_scanner_hidden_${userId}` : "fildi_scanner_hidden";
}

// ── Main Page ─────────────────────────────────────────────────────────────────

export function OptionsScannerContent({ showHeader = true }: { showHeader?: boolean }) {
  const { isAdmin, user } = useAuth();
  const { weights } = useScoringPreferences();

  // sessionStorage (not localStorage) — expanded rows are tab-lifetime UI state,
  // restored on returning to this tab/sub-tab, but not meant to persist forever.
  const [expandedSet,   setExpandedSet]   = useState<Set<string>>(() => {
    try { const s = sessionStorage.getItem("fildi_scanner_expanded"); return s ? new Set(JSON.parse(s)) : new Set(); } catch { return new Set(); }
  });
  const [refreshedOptions, setRefreshedOptions] = useState<Map<string, OptionsChainResult[]>>(new Map());
  const [overrides,     setOverrides]     = useState<Set<string>>(new Set());
  const [sort,          setSort]          = useState<SortKey>("income");
  const [show1wk,       setShow1wk]       = useState(true);
  const [minIncome,     setMinIncome]     = useState(() => getTraderPrefs(user?.id).minWeeklyIncome);
  const [minIncomeInput, setMinIncomeInput] = useState(() => String(getTraderPrefs(user?.id).minWeeklyIncome));
  const [refreshedAt,   setRefreshedAt]   = useState(() => new Date());
  const [hiddenTickers, setHiddenTickers] = useState<Set<string>>(() => {
    try { const s = localStorage.getItem(scannerHiddenKey(user?.id)); return s ? new Set(JSON.parse(s)) : new Set(); } catch { return new Set(); }
  });

  // Reload from the new user's key on account switch (covers login/logout without a full page reload)
  useEffect(() => {
    try { const s = localStorage.getItem(scannerHiddenKey(user?.id)); setHiddenTickers(s ? new Set(JSON.parse(s)) : new Set()); } catch { setHiddenTickers(new Set()); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.id]);

  useEffect(() => { localStorage.setItem(scannerHiddenKey(user?.id), JSON.stringify([...hiddenTickers])); }, [hiddenTickers, user?.id]);
  useEffect(() => { saveTraderPrefs({ minWeeklyIncome: minIncome }, user?.id); }, [minIncome, user?.id]);
  useEffect(() => { try { sessionStorage.setItem("fildi_scanner_expanded", JSON.stringify([...expandedSet])); } catch {} }, [expandedSet]);

  const { entries, isLoaded } = useWatchlist();

  const activeTickers = useMemo(
    () => entries.filter(e => e.colorTag !== RED_TAG).map(e => e.ticker),
    [entries],
  );
  const colorMap = useMemo(
    () => new Map(entries.map(e => [e.ticker, e.colorTag])),
    [entries],
  );

  // Watchlist tickers minus hidden
  const displayTickers = useMemo(
    () => activeTickers.filter(t => !hiddenTickers.has(t)),
    [activeTickers, hiddenTickers],
  );

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

  // ── Options — one batched request for all display tickers ───────────────────
  // Every sort key (income/buffer/otm/optionScore) is computed FROM the options
  // chain, so there's no way to lazy-load "just the top N" — the ranking itself
  // depends on having every ticker's chain. Batching avoids an N-way parallel
  // burst against Yahoo; the server caps concurrency and reuses optionsCache.
  const displayTickersKey = useMemo(() => [...displayTickers].sort().join(","), [displayTickers]);

  const { data: batchOptionsData, isFetching: batchOptionsFetching } = useQuery({
    queryKey:             ["options-batch", displayTickersKey],
    queryFn:              async () => {
      const res = await fetch(`/api/options/batch?tickers=${encodeURIComponent(displayTickersKey)}`);
      if (!res.ok) throw new Error("options batch fetch failed");
      return res.json() as Promise<Record<string, OptionsChainResult[] | { error: string }>>;
    },
    enabled:              isLoaded && displayTickers.length > 0,
    staleTime:            5 * 60_000,
    refetchOnWindowFocus: false,
  });

  // ── Derived maps ─────────────────────────────────────────────────────────────
  const scorecardMap = useMemo(
    () => new Map((scorecardData ?? []).map(r => [r.ticker, r])),
    [scorecardData],
  );

  const optionsMap = useMemo(() => {
    const m = new Map<string, OptionsChainResult[] | null>();
    displayTickers.forEach(t => {
      const refreshed = refreshedOptions.get(t);
      if (refreshed) { m.set(t, refreshed); return; }
      const entry = batchOptionsData?.[t];
      m.set(t, entry && !("error" in entry) ? entry : null);
    });
    return m;
  }, [displayTickers, batchOptionsData, refreshedOptions]);

  const optionsLoadingMap = useMemo(() => {
    const m = new Map<string, boolean>();
    displayTickers.forEach(t => {
      const hasData = refreshedOptions.has(t) || !!batchOptionsData?.[t];
      m.set(t, batchOptionsFetching && !hasData);
    });
    return m;
  }, [displayTickers, batchOptionsFetching, batchOptionsData, refreshedOptions]);

  // ── Volatility regime (VIX-band, intraday) — for Option Scorer overlay ───────
  // Distinct from the business-cycle "macro-regime" used on home.tsx.
  const { data: macroRegimeData } = useQuery({
    queryKey: ["volatility", "regime"],
    queryFn: async (): Promise<MacroRegimeResult> => {
      const res = await fetch("/api/volatility/regime");
      if (!res.ok) return { vix: null, spxChange1d: null, ndxChange1d: null, rutChange1d: null, regime: "BASELINE", indexDirection: "NEUTRAL", error: "fetch failed" };
      return res.json();
    },
    staleTime: 5 * 60_000,
    refetchOnWindowFocus: false,
  });

  // ── Fundamental rankings — for Option Scorer stock quality component ──────────
  const { data: fundRankingsData } = useQuery({
    queryKey: queryKeys.fundamentalsRankings,
    queryFn: async (): Promise<Array<{ ticker: string; totalScore: number }>> => {
      const res = await fetch("/api/fundamentals/rankings");
      if (!res.ok) throw new Error("fundamentals/rankings failed");
      return res.json();
    },
    refetchOnWindowFocus: false,
  });

  // V2: self-relative scores over all 31 watchlist rows — invariant to display filter
  const rankings = useMemo(() => {
    if (!allTechnicalsData?.length) return new Map<string, TechnicalScore>();
    return new Map(computeTechnicalRankingsV2(allTechnicalsData, {}, weights.technical).map(s => [s.ticker, s]));
  }, [allTechnicalsData, weights.technical]);

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
      const picked = pickBestStrike(chains, stockCtx, macroRegimeData?.regime ?? "BASELINE", allWatchlistIVs, undefined, weights.optionStrike);
      if (picked) m.set(ticker, picked.result.optionScore);
    }
    return m;
  }, [displayTickers, optionsMap, techRowMap, rankings, fundScoreMap, macroRegimeData, allWatchlistIVs, weights.optionStrike]);

  // Best weekly income % per ticker (drives "Income%" sort + column display)
  const bestIncomeMap = useMemo(() => {
    const m = new Map<string, number>();
    for (const ticker of displayTickers) {
      const chains = optionsMap.get(ticker);
      if (!chains) continue;
      let best = -1;
      for (const c of chains) {
        const settlementDte = Math.max(0.01, c.settlementDte ?? c.exactDte ?? c.daysToExpiry);
        for (const p of c.puts) {
          const wi = p.incomePct / (settlementDte / 7);
          if (wi > best) best = wi;
        }
      }
      if (best >= 0) m.set(ticker, best);
    }
    return m;
  }, [displayTickers, optionsMap]);

  // Best buffer (SDs OTM) per ticker (drives "Buffer" sort + column display)
  const bufferMap = useMemo(() => {
    const m = new Map<string, number>();
    for (const ticker of displayTickers) {
      const chains = optionsMap.get(ticker);
      if (!chains) continue;
      const spot = chains[0]?.spot ?? 0;
      if (!spot) continue;
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
      if (best >= 0) m.set(ticker, best);
    }
    return m;
  }, [displayTickers, optionsMap]);

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
      }, weights.optionStock);
      m.set(ticker, result.stockScore);
    }
    return m;
  }, [displayTickers, techRowMap, scorecardMap, optionsMap, rankings, fundScoreMap, bestOptionScoreMap, colorMap, weights.optionStock]);

  // ── Sort + filter ─────────────────────────────────────────────────────────────
  // Re-sorts whenever the score map behind the active sort key actually changes
  // (e.g. options/technicals data finishes loading) — previously this read stale
  // snapshots via refs, which froze row order at whatever (mostly-empty) scores
  // existed on first render and never converged to match the displayed values.
  const sortedTickers = useMemo(() => {
    const optMap     = optionsMap;
    const bestScores  = bestOptionScoreMap;
    const stockScores = stockScoreMap;
    const scorecard   = scorecardMap;
    const incomeMap   = bestIncomeMap;
    const bufMap      = bufferMap;

    let list = [...displayTickers];

    list.sort((a, b) => {
      switch (sort) {
        case "optionScore":
          return (bestScores.get(b) ?? -1) - (bestScores.get(a) ?? -1);
        case "score":
          return (stockScores.get(b) ?? 0) - (stockScores.get(a) ?? 0);
        case "iv": {
          const iv = (t: string) => scorecard.get(t)?.ivCurrent ?? -1;
          return iv(b) - iv(a);
        }
        case "buffer":
          return (bufMap.get(b) ?? -1) - (bufMap.get(a) ?? -1);
        case "otm": {
          const otm = (t: string) => {
            const chains = optMap.get(t);
            if (!chains) return -1;
            const spot = chains[0]?.spot ?? 0;
            const best = Math.max(...chains.flatMap((c: OptionsChainResult) => c.puts.filter((p: OptionRow) => p.meetsGate).map((p: OptionRow) => p.strike)), 0);
            return spot > 0 && best > 0 ? ((spot - best) / spot) * 100 : -1;
          };
          return otm(b) - otm(a);
        }
        case "income":
        default:
          return (incomeMap.get(b) ?? -1) - (incomeMap.get(a) ?? -1);
      }
    });
    return list;
  }, [displayTickers, sort, optionsMap, bestOptionScoreMap, stockScoreMap, scorecardMap, bestIncomeMap, bufferMap]);

  // ── Handlers ──────────────────────────────────────────────────────────────────
  const handleExpand = (ticker: string) => {
    setExpandedSet(prev => {
      const next = new Set(prev);
      next.has(ticker) ? next.delete(ticker) : next.add(ticker);
      return next;
    });
  };

  const handleRowRefresh = async (ticker: string) => {
    try {
      const res = await fetch(`/api/options/${ticker}`);
      if (!res.ok) throw new Error(`options refresh failed: ${ticker}`);
      const data = await res.json() as OptionsChainResult[];
      setRefreshedOptions(prev => new Map(prev).set(ticker, data));
    } catch {
      // keep existing data on failure
    }
  };

  const handleOverride = (ticker: string) => {
    setOverrides(prev => new Set([...prev, ticker]));
  };

  const handleDelete = (ticker: string) => {
    setHiddenTickers(prev => new Set([...prev, ticker]));
    setExpandedSet(prev => { const n = new Set(prev); n.delete(ticker); return n; });
    setOverrides(prev => { const n = new Set(prev); n.delete(ticker); return n; });
  };

  const handleGlobalRefresh = () => {
    refetchScorecard();
    setRefreshedAt(new Date());
  };

  // ── Render ────────────────────────────────────────────────────────────────────

  return (
    <div className="space-y-4">
        {showHeader && <h1 className="text-xl font-bold">Options Scanner</h1>}

        {/* Controls */}
        <div className="flex items-center gap-2 flex-wrap">
          {/* Filter chips */}
          <button
            onClick={() => setShow1wk(v => !v)}
            className={cn(
              "px-2.5 py-1 text-xs rounded-md border transition-colors",
              show1wk
                ? "border-primary/50 bg-primary/10 text-primary"
                : "border-border text-white",
            )}
          >
            1wk
          </button>

          {/* Editable min income filter */}
          <div className="flex items-center gap-1 border border-border rounded-md px-2 h-7">
            <span className="text-xs text-white">≥</span>
            <input
              type="number"
              min="0"
              step="0.1"
              value={minIncomeInput}
              onChange={e => {
                setMinIncomeInput(e.target.value);
                const n = parseFloat(e.target.value);
                if (Number.isFinite(n) && n >= 0) setMinIncome(n);
              }}
              className="w-10 text-xs bg-transparent text-foreground focus:outline-none text-center"
            />
            <span className="text-xs text-white">%/wk</span>
          </div>

        </div>

        {/* Scanner table */}
        {scorecardLoading || !isLoaded ? (
          <div className="flex items-center gap-2 text-sm text-white py-8 justify-center">
            <Loader2 className="w-4 h-4 animate-spin" />
            Loading scorecard…
          </div>
        ) : sortedTickers.length === 0 ? (
          <div className="text-sm text-white py-8 text-center">
            No tickers match current filters.
          </div>
        ) : (
          <div className="rounded-md border border-border overflow-hidden">
            {/* Column headers */}
            <div className="flex items-center gap-3 px-4 py-2 border-b border-border bg-slate-900/80 text-xs font-bold tracking-wider uppercase text-white" style={{ borderLeft: "4px solid transparent" }}>
              <div className="w-[70px] shrink-0">Ticker</div>
              <div className="w-[80px] shrink-0">Price</div>
              <div className="w-[56px] shrink-0">Signal</div>
              <SortableHeader label="Option Score" sortKey="optionScore" active={sort === "optionScore"} width="w-[90px]" onClick={setSort} />
              <SortableHeader label="Stock Score" sortKey="score" active={sort === "score"} width="w-[90px]" onClick={setSort} />
              <SortableHeader label="IV%" sortKey="iv" active={sort === "iv"} width="w-[52px]" onClick={setSort} />
              <SortableHeader label="Income%" sortKey="income" active={sort === "income"} width="w-[72px]" onClick={setSort} />
              <SortableHeader label="Buffer" sortKey="buffer" active={sort === "buffer"} width="w-[64px]" onClick={setSort} />
              <div className="flex-1">Best Strikes</div>
              {isAdmin && (
                <button
                  className="flex items-center gap-1.5 text-xs normal-case font-normal tracking-normal text-white transition-colors shrink-0"
                  onClick={handleGlobalRefresh}
                  disabled={scorecardLoading}
                >
                  {scorecardLoading
                    ? <Loader2 className="w-3.5 h-3.5 animate-spin" />
                    : <RefreshCw className="w-3.5 h-3.5" />
                  }
                  {minutesAgo(refreshedAt)}
                </button>
              )}
            </div>
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
                minIncome={minIncome}
                overrideEnabled={overrides.has(ticker)}
                onExpand={() => handleExpand(ticker)}
                onRefresh={isAdmin ? () => handleRowRefresh(ticker) : undefined}
                onDelete={() => handleDelete(ticker)}
                onOverride={() => handleOverride(ticker)}
                techRow={techRowMap.get(ticker) ?? null}
                fundTotalScore={fundScoreMap.get(ticker) ?? null}
                macroRegime={macroRegimeData?.regime ?? "BASELINE"}
                allWatchlistIVs={allWatchlistIVs}
                strikeWeights={weights.optionStrike}
                bestOptionScore={bestOptionScoreMap.get(ticker) ?? null}
                bestIncome={bestIncomeMap.get(ticker) ?? null}
                bestBuffer={bufferMap.get(ticker) ?? null}
                stockScore={stockScoreMap.get(ticker) ?? null}
              />
            ))}
          </div>
        )}
    </div>
  );
}

export default function OptionsScanner() {
  return (
    <div className="min-h-screen bg-background">
      <TopNav />
      <main className="pt-14 p-6 space-y-4">
        <OptionsScannerContent />
      </main>
    </div>
  );
}
