import { useState, useMemo, useEffect, useRef, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import { useQuery } from "@tanstack/react-query";
import { LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer } from "recharts";
import { TopNav } from "@/components/top-nav";
import { Badge } from "@/components/ui/badge";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { cn } from "@/lib/utils";
import { useWatchlist, PRESET_COLORS } from "@/hooks/use-watchlist";
import {
  computeTechnicalRankingsV2,
  type TechnicalRow,
  type IndicatorResult,
  type TechnicalScore,
} from "@/lib/technical-rankings";
import { ChevronDown, ChevronRight, RefreshCw, Loader2, X, Sparkles, TrendingUp, ListFilter, Search } from "lucide-react";
import { pickBestStrike, computeOptionScore, buildCandidate, type StockContext, type OptionScoreResult } from "@/lib/option-scorer";
import { computeRelativeMove, computeStockScore } from "@/lib/stock-scorer";
import { useScoringPreferences } from "@/context/ScoringPreferencesContext";
import { type MacroRegime, REGIME_INCOME_TARGET, REGIME_INCOME_FLOOR, CALL_STRIKE_WEIGHTS } from "@/lib/option-scorer-constants";
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
  calls: OptionRow[];
  fetchedAt: number;
}

interface IvTermPoint {
  label:  string; // "1W" | "1M" | "2M" | "3M" | "6M" | "1Y"
  expiry: string;
  dte:    number;
  iv:     number; // decimal, e.g. 0.32
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

function viableOptionStrikes(
  chains: OptionsChainResult[],
  minWeeklyIncome: number,
  isCall: boolean = false,
): Array<{ chain: OptionsChainResult; put: OptionRow; weeklyIncome: number }> {
  return chains
    .flatMap(c => {
      const settlementDte = c.settlementDte ?? c.exactDte ?? Math.max(1, c.daysToExpiry);
      return (isCall ? c.calls : c.puts)
        .map(p => ({ chain: c, put: p, weeklyIncome: p.incomePct / (settlementDte / 7) }))
        .filter(x => x.weeklyIncome >= minWeeklyIncome);
    });
}

function optionStrikeSummary(
  chains: OptionsChainResult[] | null,
  minWeeklyIncome: number,
  isCall: boolean = false,
): string {
  if (!chains) return "—";
  const strikes = viableOptionStrikes(chains, minWeeklyIncome, isCall);
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

function StrikeRow({
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

function StrikeTableHeader() {
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

  return (
    <div className="rounded-md border border-zinc-600/40 overflow-hidden bg-zinc-900/70 shadow-lg shadow-black/40">
      {/* Expiry group header — warm tan accent so it reads as a section divider, not more body text */}
      <button
        className={cn(
          "w-full flex items-center gap-2 px-3 py-0.5 text-left transition-colors",
          "hover:bg-amber-500/15 bg-amber-500/10 border-b border-amber-500/20",
        )}
        onClick={() => setCollapsed(c => !c)}
      >
        {collapsed
          ? <ChevronRight className="w-3.5 h-3.5 text-white shrink-0" />
          : <ChevronDown className="w-3.5 h-3.5 text-white shrink-0" />
        }
        <span className="font-bold text-xs tracking-wide text-foreground">
          {formatExpiry(chain.expiry, chain.daysToExpiry)}
        </span>
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

// ── IV term structure chart (ticker-level — ATM IV across the expiry calendar) ─

function IvTermStructureChart({ data, isLoading }: { data: IvTermPoint[] | undefined; isLoading: boolean }) {
  if (isLoading) {
    return (
      <div className="flex items-center gap-2 text-xs text-white py-4">
        <Loader2 className="w-3 h-3 animate-spin" />
        Loading term structure…
      </div>
    );
  }
  if (!data || data.length === 0) {
    return <p className="text-xs text-white italic py-4">No term structure data available.</p>;
  }

  const points = data.map(d => ({ ...d, ivPct: d.iv * 100 }));
  const first = points[0]!.ivPct;
  const last = points[points.length - 1]!.ivPct;
  const shape = last > first * 1.03 ? "Contango" : last < first * 0.97 ? "Backwardation" : "Flat";
  const shapeColor = shape === "Backwardation" ? "text-orange-400" : shape === "Contango" ? "text-green-400" : "text-white";

  return (
    <div className="space-y-1 py-1">
      <div className="flex items-center justify-between px-1">
        <span className="text-[10px] text-white uppercase tracking-wide">ATM IV by expiry</span>
        <span className={cn("text-[10px] font-semibold", shapeColor)}>{shape}</span>
      </div>
      <ResponsiveContainer width="100%" height={140}>
        <LineChart data={points} margin={{ top: 6, right: 10, left: 0, bottom: 0 }}>
          <XAxis dataKey="label" tick={{ fontSize: 9, fill: "#fff" }} axisLine={{ stroke: "#3f3f46" }} tickLine={false} />
          <YAxis tick={{ fontSize: 9, fill: "#fff" }} axisLine={{ stroke: "#3f3f46" }} tickLine={false} width={36} tickFormatter={v => `${v}%`} />
          <Tooltip content={(p) => {
            const d = p.payload?.[0]?.payload as (IvTermPoint & { ivPct: number }) | undefined;
            if (!p.active || !d) return null;
            return (
              <div className="bg-popover border border-border rounded-lg px-2.5 py-1.5 shadow-xl text-xs space-y-0.5">
                <div className="text-white font-bold">{d.label} · {d.dte}d · exp {d.expiry}</div>
                <div className="text-amber-400 font-bold tabular-nums">{d.ivPct.toFixed(1)}% IV</div>
              </div>
            );
          }} />
          <Line type="monotone" dataKey="ivPct" stroke="#fbbf24" strokeWidth={1.75} dot={{ r: 3, fill: "#fbbf24" }} />
        </LineChart>
      </ResponsiveContainer>
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
}

function ScannerRow({
  ticker,
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
}: ScannerRowProps) {
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

  // Only score the side (puts or calls) this row was told to render — scoring both
  // unconditionally on every render was wasted work when only one is ever shown.
  const effectiveWeights = isCall ? CALL_STRIKE_WEIGHTS : strikeWeights;
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

  return (
    <div className="border-b border-border last:border-b-0">
      {/* Collapsed header row */}
      <div
        className="flex items-center gap-2 px-3 py-0.5 cursor-pointer hover:bg-secondary/30 transition-colors select-none"
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

        <div className="w-[56px] shrink-0 flex items-center gap-1">
          <SignalBadge signal={signal} />
          {callWarnings.length > 0 && (
            <span className="text-amber-400 text-[10px] leading-none" title={callWarnings.join(" · ")}>⚠</span>
          )}
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

// DOM id for an optional host element (e.g. rendered inline in a tab bar by a parent page)
// that the min-income filter portals into instead of its own default control row.
export const OPTIONS_FILTER_SLOT_ID = "options-filter-bar-slot";

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
  const [sort,          setSort]          = useState<SortKey>("optionScore");
  // Sell Puts vs. Sell Calls — a page-level mode, not a per-row sub-tab, so the whole
  // table (scores, sort, expanded strike view) is scoped consistently to one side at a time.
  const [scanMode,      setScanMode]      = useState<"puts" | "calls">(() => {
    try { return (localStorage.getItem("fildi_scanner_mode") as "puts" | "calls") || "puts"; } catch { return "puts"; }
  });
  const isCallMode = scanMode === "calls";
  useEffect(() => { try { localStorage.setItem("fildi_scanner_mode", scanMode); } catch {} }, [scanMode]);
  const [minIncome,     setMinIncome]     = useState(() => getTraderPrefs(user?.id).minWeeklyIncome);
  const [minIncomeInput, setMinIncomeInput] = useState(() => String(getTraderPrefs(user?.id).minWeeklyIncome));
  const [tickerQuery,   setTickerQuery]   = useState("");
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

  // If a parent page (e.g. the Fundamentals/Technicals/Options tab bar in rankings.tsx)
  // renders a host element with this id, portal the filter control there instead of
  // showing it in this component's own control row.
  const [filterSlot, setFilterSlot] = useState<HTMLElement | null>(null);
  useEffect(() => { setFilterSlot(document.getElementById(OPTIONS_FILTER_SLOT_ID)); }, []);

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

  // V2: self-relative scores over all 31 watchlist rows — invariant to display filter.
  // Side-aware: call mode scores overbought/exhaustion/extension (sell calls into
  // strength) instead of the put-side oversold/reversal components.
  const rankings = useMemo(() => {
    if (!allTechnicalsData?.length) return new Map<string, TechnicalScore>();
    return new Map(
      computeTechnicalRankingsV2(allTechnicalsData, {}, weights.technical, isCallMode ? "call" : "put")
        .map(s => [s.ticker, s]),
    );
  }, [allTechnicalsData, weights.technical, isCallMode]);

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

  // Best option per ticker (drives optionScore/Income%/Buffer sort + column display).
  // All three columns must come off the SAME picked strike from pickBestStrike —
  // previously Income%/Buffer independently re-scanned every strike for its own max,
  // which could land on a different strike/expiry than the one actually scored.
  const { bestOptionScoreMap, bestIncomeMap, bufferMap } = useMemo(() => {
    const scoreMap = new Map<string, number>();
    const incomeMap = new Map<string, number>();
    const bufMap = new Map<string, number>();
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
        swingHigh20d:          pfNum(techRow.swingHigh20d),
        swingHigh50d:          pfNum(techRow.swingHigh50d),
        pivotR1:               pfNum(techRow.pivotR1),
        nearestSupportDistPct: pfNum(techRow.nearestSupportDistPct),
        techTotalScore:        rankings.get(ticker)?.totalScore ?? null,
        fundTotalScore:        fundScoreMap.get(ticker) ?? null,
      };
      const picked = pickBestStrike(
        chains.map(c => ({ ...c, options: isCallMode ? c.calls : c.puts })),
        stockCtx, macroRegimeData?.regime ?? "BASELINE", allWatchlistIVs, undefined,
        isCallMode ? CALL_STRIKE_WEIGHTS : weights.optionStrike, isCallMode,
      );
      if (!picked) continue;
      scoreMap.set(ticker, picked.result.optionScore);
      incomeMap.set(ticker, picked.result.weeklyIncome);
      const spot = picked.chain.spot ?? 0;
      const exactDte = picked.chain.exactDte ?? Math.max(1, picked.chain.daysToExpiry);
      if (spot > 0 && picked.put.iv > 0 && exactDte > 0) {
        const otm = isCallMode ? (picked.put.strike - spot) / spot : (spot - picked.put.strike) / spot;
        bufMap.set(ticker, otm / (picked.put.iv * Math.sqrt(exactDte / 365)));
      }
    }
    return { bestOptionScoreMap: scoreMap, bestIncomeMap: incomeMap, bufferMap: bufMap };
  }, [displayTickers, optionsMap, techRowMap, rankings, fundScoreMap, macroRegimeData, allWatchlistIVs, weights.optionStrike, isCallMode]);

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
        isCallMode ? "call" : "put",
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
  }, [displayTickers, techRowMap, scorecardMap, optionsMap, rankings, fundScoreMap, bestOptionScoreMap, colorMap, weights.optionStock, isCallMode]);

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
            const strikes = chains.flatMap((c: OptionsChainResult) => (isCallMode ? c.calls : c.puts).filter((p: OptionRow) => p.meetsGate).map((p: OptionRow) => p.strike));
            if (spot <= 0 || strikes.length === 0) return -1;
            const best = isCallMode ? Math.min(...strikes) : Math.max(...strikes);
            return isCallMode ? ((best - spot) / spot) * 100 : ((spot - best) / spot) * 100;
          };
          return otm(b) - otm(a);
        }
        case "income":
        default:
          return (incomeMap.get(b) ?? -1) - (incomeMap.get(a) ?? -1);
      }
    });
    return list;
  }, [displayTickers, sort, optionsMap, bestOptionScoreMap, stockScoreMap, scorecardMap, bestIncomeMap, bufferMap, isCallMode]);

  const filteredTickers = useMemo(() => {
    const q = tickerQuery.trim().toLowerCase();
    return q ? sortedTickers.filter(t => t.toLowerCase().includes(q)) : sortedTickers;
  }, [sortedTickers, tickerQuery]);

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

  // Editable min-income filter — hides strikes that return less than this % per week.
  // Portals into the parent tab bar when embedded in rankings.tsx (see filterSlot above);
  // falls back to rendering inline above the table when used standalone (e.g. /options-scanner).
  const filterBar = (
    <div
      className="flex items-center gap-1.5 border border-emerald-500/30 bg-emerald-500/5 rounded-full pl-2.5 pr-1 h-7"
      title="Minimum weekly return filter — hides option strikes that yield less than this % of the strike price per week"
    >
      <TrendingUp className="w-3 h-3 text-emerald-400 shrink-0" />
      <span className="text-xs text-white whitespace-nowrap">Min %/wk</span>
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
        className="w-10 text-xs bg-transparent text-foreground focus:outline-none text-center font-mono"
      />
    </div>
  );

  const tickerFilterBar = (
    <div className="relative">
      <Search className="w-3.5 h-3.5 text-gray-500 absolute left-2 top-1/2 -translate-y-1/2" />
      <input
        type="text"
        value={tickerQuery}
        onChange={e => setTickerQuery(e.target.value)}
        placeholder="Filter ticker..."
        className="h-7 w-36 pl-7 pr-2 text-xs rounded-md border border-white/20 bg-white text-black placeholder:text-gray-500 focus:outline-none focus:ring-2 focus:ring-primary"
      />
    </div>
  );

  // Sell Puts / Sell Calls — swaps the whole table (scores, sort, expanded strikes) to
  // the other side. Both are served from the same already-fetched per-ticker options
  // batch (optionsCache on the server), so switching never triggers a network request.
  const scanModeToggle = (
    <div className="flex items-center rounded-full border border-border/60 bg-slate-900/40 p-0.5 text-xs h-7 shrink-0">
      <button
        onClick={() => setScanMode("puts")}
        className={cn(
          "px-2.5 h-6 rounded-full transition-colors font-semibold",
          !isCallMode ? "bg-primary/20 text-primary" : "text-white/70 hover:text-white",
        )}
      >
        Sell Puts
      </button>
      <button
        onClick={() => setScanMode("calls")}
        className={cn(
          "px-2.5 h-6 rounded-full transition-colors font-semibold",
          isCallMode ? "bg-primary/20 text-primary" : "text-white/70 hover:text-white",
        )}
      >
        Sell Calls
      </button>
    </div>
  );

  const controlsRow = (
    <div className="flex items-center gap-2">
      {scanModeToggle}
      {filterBar}
      {tickerFilterBar}
    </div>
  );

  return (
    <div className="space-y-4">
        {showHeader && <h1 className="text-xl font-bold">Options Scanner</h1>}

        {/* Controls — hidden here and portaled into the tab bar when filterSlot is present */}
        {!filterSlot && (
          <div className="flex items-center gap-2 flex-wrap">
            {controlsRow}
          </div>
        )}
        {filterSlot && createPortal(controlsRow, filterSlot)}

        {/* Scanner table */}
        {scorecardLoading || !isLoaded ? (
          <div className="flex items-center gap-2 text-sm text-white py-8 justify-center">
            <Loader2 className="w-4 h-4 animate-spin" />
            Loading scorecard…
          </div>
        ) : filteredTickers.length === 0 ? (
          <div className="text-sm text-white py-8 text-center">
            No tickers match current filters.
          </div>
        ) : (
          <div className="rounded-md border border-border overflow-hidden">
            {/* Column headers */}
            <div className="flex items-center gap-2 px-3 py-1 border-b border-border bg-slate-900/80 text-xs font-bold tracking-wider uppercase text-white" style={{ borderLeft: "4px solid transparent" }}>
              <div className="w-[70px] shrink-0">Ticker</div>
              <div className="w-[80px] shrink-0">Price</div>
              <div className="w-[56px] shrink-0">Signal</div>
              <div className="w-[48px] shrink-0" title="Hover a row's RSI value for full reasoning">RSI</div>
              <SortableHeader label="Option Score" sortKey="optionScore" active={sort === "optionScore"} width="w-[90px]" onClick={setSort} />
              <SortableHeader label="Stock Score" sortKey="score" active={sort === "score"} width="w-[90px]" onClick={setSort} />
              <SortableHeader label="IV%" sortKey="iv" active={sort === "iv"} width="w-[52px]" onClick={setSort} />
              <SortableHeader label="Income%" sortKey="income" active={sort === "income"} width="w-[72px]" onClick={setSort} />
              <SortableHeader label="Buffer" sortKey="buffer" active={sort === "buffer"} width="w-[64px]" onClick={setSort} />
              <div className="flex-1" />
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
            {filteredTickers.map(ticker => (
              <ScannerRow
                key={ticker}
                ticker={ticker}
                colorTag={colorMap.get(ticker) ?? ""}
                indicator={scorecardMap.get(ticker) ?? null}
                score={rankings.get(ticker) ?? null}
                optionsData={optionsMap.get(ticker) ?? null}
                optionsLoading={optionsLoadingMap.get(ticker) ?? false}
                expanded={expandedSet.has(ticker)}
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
                isCall={isCallMode}
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
