import { useState, useMemo, type Dispatch, type SetStateAction } from "react";
import { useQuery, useQueries } from "@tanstack/react-query";
import { useWatchlist } from "@/hooks/use-watchlist";
import { Sidebar } from "@/components/sidebar";
import { TickerShelf } from "@/components/ticker-shelf";
import { Badge } from "@/components/ui/badge";
import { ChevronDown, Loader2, Plus, RefreshCw, Trophy } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  type IndicatorResult,
  type TechnicalScore,
  type TechnicalRow,
  computeTechnicalRankingsV2,
  // V1 kept exported — remove after one release
  computeTechnicalRankings as _computeTechnicalRankingsV1,
} from "@/lib/technical-rankings";

// ── Constants ─────────────────────────────────────────────────────────────────

const MAX_SLOTS   = 5;
const SLOT_COLORS = ["#38bdf8", "#fb923c", "#34d399", "#a78bfa", "#f472b6"];

// ── Small helpers ─────────────────────────────────────────────────────────────

function TierBadge({ tier }: { tier: 1 | 2 | 3 }) {
  const cls =
    tier === 1 ? "bg-blue-500/15 text-blue-400 border-blue-500/20" :
    tier === 2 ? "bg-purple-500/15 text-purple-400 border-purple-500/20" :
                 "bg-orange-500/15 text-orange-400 border-orange-500/20";
  return (
    <Badge variant="outline" className={cn("text-[10px] px-1.5 py-0 h-4 font-semibold", cls)}>
      T{tier}
    </Badge>
  );
}

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

function IndicatorBar({ value, threshold, ok }: { value: number; threshold: number; ok: boolean }) {
  const pct   = Math.min(100, (value / threshold) * 100);
  const color = ok ? "bg-green-500" : value >= threshold - 5 ? "bg-yellow-500" : "bg-red-500";
  return (
    <div className="h-1 w-full bg-secondary rounded-full overflow-hidden">
      <div className={cn("h-full rounded-full transition-all", color)} style={{ width: `${pct}%` }} />
    </div>
  );
}

function MacdBadge({ cross }: { cross: IndicatorResult["macdCross"] }) {
  if (!cross) return null;
  const isBull  = cross.startsWith("BULLISH");
  const isCross = cross.endsWith("_CROSS");
  const label   = isCross ? (isBull ? "MACD↑" : "MACD↓") : (isBull ? "MACD+" : "MACD−");
  const cls     = isBull
    ? "bg-green-500/10 text-green-400 border-green-500/20"
    : "bg-red-500/10 text-red-400 border-red-500/20";
  return (
    <Badge variant="outline" className={cn("text-[10px] px-1.5 py-0 h-4", isCross && "font-bold", cls)}>
      {label}
    </Badge>
  );
}

// ── 5-slot card row ───────────────────────────────────────────────────────────

interface TechnicalCardsProps {
  tickers: string[];
  data: Record<string, IndicatorResult | null>;
  loading: Record<string, boolean>;
  errors: Record<string, boolean>;
  scores: TechnicalScore[];
  onAddClick: () => void;
  onRemove: (t: string) => void;
  onRefresh: (t: string) => void;
  refreshing: Set<string>;
}

function TechnicalCards({ tickers, data, loading, errors, scores, onAddClick, onRemove, onRefresh, refreshing }: TechnicalCardsProps) {
  const slots      = Array.from({ length: MAX_SLOTS }, (_, i) => tickers[i] ?? null);
  const scoreMap   = Object.fromEntries(scores.map(s => [s.ticker, s]));
  const showRanks  = scores.length >= 2;

  return (
    <div className="grid grid-cols-5 gap-3">
      {slots.map((ticker, i) => {
        const color = SLOT_COLORS[i];

        if (!ticker) {
          return (
            <button
              key={`empty-${i}`}
              onClick={onAddClick}
              className="h-[200px] rounded-xl border border-dashed border-border/60 bg-card/30 flex flex-col items-center justify-center gap-2 text-muted-foreground hover:border-primary/50 hover:text-primary hover:bg-primary/5 transition-all group"
              style={{ borderLeftColor: color, borderLeftWidth: 3 }}
            >
              <div className="w-8 h-8 rounded-full border border-dashed border-current flex items-center justify-center group-hover:border-solid transition-all">
                <Plus className="w-4 h-4" />
              </div>
              <span className="text-xs font-medium">Add Ticker</span>
            </button>
          );
        }

        if (loading[ticker]) {
          return (
            <div
              key={ticker}
              className="h-[200px] rounded-xl border border-border bg-card shadow-sm flex items-center justify-center"
              style={{ borderLeftColor: color, borderLeftWidth: 3 }}
            >
              <Loader2 className="w-5 h-5 animate-spin text-muted-foreground" />
            </div>
          );
        }

        const d = data[ticker];
        if (!d) {
          const failed = errors[ticker];
          return (
            <div
              key={ticker}
              className="h-[200px] rounded-xl border border-border bg-card shadow-sm p-3 flex flex-col justify-between"
              style={{ borderLeftColor: color, borderLeftWidth: 3 }}
            >
              <div className="flex items-center justify-between">
                <span className="font-mono font-bold text-base tracking-tight" style={{ color }}>{ticker}</span>
                <button onClick={() => onRemove(ticker)} className="text-muted-foreground hover:text-foreground text-xs w-5 h-5 flex items-center justify-center">×</button>
              </div>
              {failed ? (
                <div className="flex flex-col items-center gap-2">
                  <p className="text-xs text-red-400">Fetch failed</p>
                  <button
                    onClick={() => onRefresh(ticker)}
                    className="text-xs text-muted-foreground hover:text-foreground underline underline-offset-2"
                  >
                    Retry
                  </button>
                </div>
              ) : (
                <p className="text-xs text-muted-foreground">No data</p>
              )}
            </div>
          );
        }

        const earningsSoon = d.earningsDate
          ? (new Date(d.earningsDate + "T12:00:00").getTime() - Date.now()) / 86400000 < 14
          : false;

        const ts = scoreMap[ticker];

        return (
          <div
            key={ticker}
            className="rounded-xl border border-border bg-card shadow-sm p-3 flex flex-col gap-2.5"
            style={{ borderLeftColor: color, borderLeftWidth: 3 }}
          >
            {/* Header row */}
            <div className="flex items-start justify-between">
              <div>
                <div className="flex items-center gap-1.5">
                  <span className="font-mono font-bold text-base tracking-tight" style={{ color }}>{ticker}</span>
                  {showRanks && ts && (
                    <span className="text-[10px] font-bold text-muted-foreground bg-secondary px-1.5 py-0.5 rounded">
                      #{ts.rank}
                    </span>
                  )}
                </div>
                <div className="flex items-center gap-1 mt-0.5">
                  <TierBadge tier={d.tier} />
                  <SignalBadge signal={ts?.signal ?? d.signal} />
                  {earningsSoon && (
                    <Badge variant="outline" className="text-[10px] px-1.5 py-0 h-4 bg-orange-500/10 text-orange-400 border-orange-500/20">EARN</Badge>
                  )}
                </div>
              </div>
              <button onClick={() => onRemove(ticker)} className="text-muted-foreground hover:text-foreground text-xs w-5 h-5 flex items-center justify-center shrink-0">×</button>
            </div>

            {/* Score bar */}
            {showRanks && ts && (
              <div className="space-y-0.5">
                <div className="flex justify-between text-[10px]">
                  <span className="text-muted-foreground">Score</span>
                  <span className="font-mono font-semibold tabular-nums text-muted-foreground">
                    {ts.totalScore.toFixed(1)} / {ts.maxPossible.toFixed(1)}
                  </span>
                </div>
                <div className="h-1 w-full bg-secondary rounded-full overflow-hidden">
                  <div
                    className="h-full rounded-full bg-primary/60 transition-all"
                    style={{ width: `${(ts.totalScore / ts.maxPossible) * 100}%` }}
                  />
                </div>
              </div>
            )}

            {/* RSI */}
            <div className="space-y-1">
              <div className="flex justify-between text-[11px]">
                <span className="text-muted-foreground">RSI 14</span>
                <span className={cn("font-mono font-semibold tabular-nums", d.rsiOk ? "text-green-400" : "text-red-400")}>
                  {d.rsi.toFixed(1)}<span className="text-muted-foreground font-normal"> /{d.rsiThreshold}</span>
                </span>
              </div>
              <IndicatorBar value={d.rsi} threshold={d.rsiThreshold} ok={d.rsiOk} />
            </div>

            {/* MFI */}
            <div className="space-y-1">
              <div className="flex justify-between text-[11px]">
                <span className="text-muted-foreground">MFI 14</span>
                <span className={cn("font-mono font-semibold tabular-nums", d.mfiOk ? "text-green-400" : "text-red-400")}>
                  {d.mfi.toFixed(1)}<span className="text-muted-foreground font-normal"> /25</span>
                </span>
              </div>
              <IndicatorBar value={d.mfi} threshold={d.mfiThreshold} ok={d.mfiOk} />
            </div>

            <div className="h-px bg-border/30" />

            {/* Extended metrics */}
            <div className="space-y-1 text-[11px]">
              {d.return5d != null && (
                <div className="flex justify-between">
                  <span className="text-muted-foreground">5d return</span>
                  <span className={cn("font-mono tabular-nums font-semibold",
                    d.return5d > 8 ? "text-red-400" : d.return5d > 3 ? "text-yellow-400" : d.return5d < 0 ? "text-green-400" : "text-foreground"
                  )}>
                    {d.return5d > 0 ? "+" : ""}{d.return5d.toFixed(1)}%
                  </span>
                </div>
              )}
              {d.position52w != null && (
                <div className="flex justify-between">
                  <span className="text-muted-foreground">52w pos</span>
                  <span className={cn("font-mono tabular-nums font-semibold",
                    d.position52w < 30 ? "text-green-400" : d.position52w > 70 ? "text-red-400" : "text-foreground"
                  )}>
                    {d.position52w.toFixed(0)}%
                  </span>
                </div>
              )}
              {d.vsSpy20d != null && (
                <div className="flex justify-between">
                  <span className="text-muted-foreground">vs SPY 20d</span>
                  <span className={cn("font-mono tabular-nums font-semibold",
                    d.vsSpy20d < 0 ? "text-green-400" : d.vsSpy20d > 5 ? "text-red-400" : "text-foreground"
                  )}>
                    {d.vsSpy20d > 0 ? "+" : ""}{d.vsSpy20d.toFixed(1)}%
                  </span>
                </div>
              )}
              {d.stoch != null && (
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Stoch %K</span>
                  <span className={cn("font-mono tabular-nums font-semibold",
                    d.stoch < 20 ? "text-green-400" : d.stoch > 80 ? "text-red-400" : "text-foreground"
                  )}>
                    {d.stoch.toFixed(1)}
                  </span>
                </div>
              )}
            </div>

            {/* Footer: MACD badge + refresh */}
            <div className="flex items-center justify-between mt-auto">
              <MacdBadge cross={d.macdCross} />
              <button
                onClick={() => onRefresh(ticker)}
                disabled={refreshing.has(ticker)}
                className="text-muted-foreground hover:text-foreground transition-colors disabled:opacity-40 ml-auto"
                title="Recompute from live data"
              >
                <RefreshCw className={cn("w-3 h-3", refreshing.has(ticker) && "animate-spin")} />
              </button>
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ── Technical Rankings Leaderboard ────────────────────────────────────────────

function TechnicalLeaderboard({ scores, rowMap }: { scores: TechnicalScore[]; rowMap?: Record<string, TechnicalRow> }) {
  const [explanations, setExplanations] = useState<Map<string, string>>(new Map());
  const [loading,      setLoading]      = useState<Set<string>>(new Set());
  const [expanded,     setExpanded]     = useState<Set<string>>(new Set());

  async function fetchExplanation(score: TechnicalScore) {
    const { ticker } = score;

    if (explanations.has(ticker)) {
      setExpanded(prev => {
        const next = new Set(prev);
        next.has(ticker) ? next.delete(ticker) : next.add(ticker);
        return next;
      });
      return;
    }

    const row = rowMap?.[ticker];
    const cs  = score.componentScores ?? {};

    setLoading(prev => new Set(prev).add(ticker));
    try {
      const res = await fetch("/api/explain/score", {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ticker,
          scoreType: "technical",
          technicalData: {
            totalScore:      score.totalScore,
            rank:            score.rank,
            signal:          score.signal,
            regime:          score.regime ?? "NEUTRAL",
            componentScores: {
              oversoldDepth:   cs["oversoldDepth"]?.score   ?? 0,
              reversalSignal:  cs["reversalSignal"]?.score  ?? 0,
              volatilityState: cs["volatilityState"]?.score ?? 0,
              trendContext:    cs["trendContext"]?.score     ?? 0,
              optionsFlow:     cs["optionsFlow"]?.score      ?? 0,
              volumeConfirm:   cs["volumeConfirm"]?.score    ?? 0,
            },
            rsi14:           parseFloat(row?.rsi14 ?? "0") || 0,
            rsi14Pct:        parseFloat(row?.rsi14Pct ?? "50") || 50,
            ivRank:          parseFloat(row?.ivRank ?? "0") || 0,
            ivVsRealizedVol: parseFloat(row?.ivVsRealizedVol ?? "1") || 1,
            macdDirection:   row?.macdDirection ?? "flat",
            fallingKnife:    (row?.fallingKnife ?? 0) === 1,
            earningsDaysOut: row?.earningsDaysOut ?? null,
            reason:          score.reason,
          },
        }),
      });
      const data = await res.json() as { explanation?: string };
      setExplanations(prev => new Map(prev).set(ticker, data.explanation ?? ""));
      setExpanded(prev => new Set(prev).add(ticker));
    } catch {
      setExplanations(prev => new Map(prev).set(ticker, "Unable to generate explanation at this time."));
      setExpanded(prev => new Set(prev).add(ticker));
    } finally {
      setLoading(prev => { const next = new Set(prev); next.delete(ticker); return next; });
    }
  }

  if (scores.length < 2) return null;

  const maxScore = scores[0].totalScore;

  const rankBadgeCls = (idx: number) =>
    idx === 0 ? "bg-yellow-500 text-yellow-950" :
    idx === 1 ? "bg-slate-400 text-slate-950"   :
    idx === 2 ? "bg-amber-700 text-amber-50"    :
                "bg-secondary text-secondary-foreground";

  const rowCls = (idx: number) =>
    idx === 0 ? "border-yellow-500/30 bg-yellow-500/5" :
    idx === 1 ? "border-slate-400/30 bg-slate-400/5"   :
    idx === 2 ? "border-amber-700/30 bg-amber-700/5"   :
                "border-border/40 bg-background/30";

  function parseBullets(text: string): string[] {
    return text
      .split(/\n|(?<=[.!?])\s{1,2}(?=[A-Z•\-])/)
      .map(s => s.replace(/^[-•*]\s*/, "").trim())
      .filter(s => s.length > 8);
  }

  return (
    <div className="bg-card border border-border rounded-xl p-4 shadow-sm">
      <div className="flex items-center gap-2 mb-3">
        <Trophy className="w-4 h-4 text-primary" />
        <h2 className="text-sm font-bold tracking-tight">Technical Rankings Leaderboard</h2>
      </div>

      <div className="flex flex-col gap-0.5">
        {scores.map((score, idx) => {
          const isLoading   = loading.has(score.ticker);
          const explanation = explanations.get(score.ticker);
          const isExpanded  = expanded.has(score.ticker);
          const bullets     = explanation ? parseBullets(explanation) : [];

          const signalCls =
            score.signal === "GO"    ? "text-green-400" :
            score.signal === "WATCH" ? "text-yellow-400" :
                                       "text-slate-500";

          return (
            <div key={score.ticker} className={cn("rounded-md border px-3 py-1.5", rowCls(idx))}>
              <div className="flex items-center gap-3">
                <div className={cn(
                  "w-6 h-6 rounded-full flex items-center justify-center font-bold text-[11px] shrink-0",
                  rankBadgeCls(idx)
                )}>
                  {score.rank}
                </div>

                <div className="w-[88px] shrink-0">
                  <span className="font-mono font-bold text-sm text-white">{score.ticker}</span>
                  <span className={cn("block text-[10px] font-bold", signalCls)}>{score.signal} · T{score.tier}</span>
                </div>

                <div className="w-[56px] shrink-0 text-right">
                  <span className="font-mono font-bold text-sm text-white">{score.totalScore.toFixed(1)}</span>
                  <span className="text-[10px] text-slate-500"> pts</span>
                </div>

                <div className="flex-1 h-1.5 bg-slate-800 rounded-full overflow-hidden">
                  <div
                    className={cn(
                      "h-full rounded-full",
                      idx === 0 ? "bg-yellow-500" : idx === 1 ? "bg-slate-400" : idx === 2 ? "bg-amber-700" : "bg-primary/60"
                    )}
                    style={{ width: `${(score.totalScore / maxScore) * 100}%` }}
                  />
                </div>

                <button
                  onClick={() => fetchExplanation(score)}
                  disabled={isLoading}
                  className="flex items-center gap-1 text-[11px] text-slate-400 hover:text-white transition-colors shrink-0 disabled:opacity-50"
                >
                  {isLoading ? "…" : "Why"}
                  <ChevronDown className={cn("w-3 h-3 transition-transform", isExpanded && "rotate-180")} />
                </button>
              </div>

              {isExpanded && bullets.length > 0 && (
                <ul className="mt-2 mb-0.5 pl-9 space-y-0.5">
                  {bullets.map((b, i) => (
                    <li key={i} className="flex items-start gap-1.5 text-xs text-white leading-snug">
                      <span className="text-slate-500 shrink-0 mt-0.5">•</span>
                      {b}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ── Technical Metrics Table ───────────────────────────────────────────────────

interface TechRowProps {
  label: string;
  tickers: string[];
  data: Record<string, IndicatorResult | null>;
  getValue: (d: IndicatorResult) => number | null;
  lowerIsBetter?: boolean;
  higherIsBetter?: boolean;
  format: (v: number) => string;
  colorFn?: (v: number) => string;
}

function TechRow({ label, tickers, data, getValue, lowerIsBetter, higherIsBetter, format, colorFn }: TechRowProps) {
  const values = tickers.map(t => {
    const d = data[t];
    return d ? getValue(d) : null;
  });

  let bestIdx: number | null = null;
  if ((lowerIsBetter || higherIsBetter) && tickers.length >= 2) {
    let best = lowerIsBetter ? Infinity : -Infinity;
    values.forEach((v, i) => {
      if (v != null && isFinite(v)) {
        if (lowerIsBetter && v < best) { best = v; bestIdx = i; }
        if (higherIsBetter && v > best) { best = v; bestIdx = i; }
      }
    });
  }

  return (
    <tr className="border-b border-border/50 hover:bg-secondary/10 transition-colors group">
      <td className="p-3 text-sm font-medium text-muted-foreground sticky left-0 bg-card group-hover:bg-card">{label}</td>
      {tickers.map((ticker, i) => {
        const v = values[i];
        const isWinner = bestIdx === i;
        const colorClass = v != null && colorFn ? colorFn(v) : "";
        return (
          <td
            key={ticker}
            className={cn(
              "p-3 text-right font-mono text-sm min-w-[100px]",
              isWinner ? "text-primary font-bold bg-primary/5" : colorClass || "text-foreground"
            )}
          >
            {v == null ? <span className="text-muted-foreground">—</span> : format(v)}
          </td>
        );
      })}
    </tr>
  );
}

function TechnicalMetricsTable({ tickers, data, scoreMap }: { tickers: string[]; data: Record<string, IndicatorResult | null>; scoreMap?: Record<string, TechnicalScore> }) {
  const loadedTickers = tickers.filter(t => data[t] != null);
  if (loadedTickers.length === 0) return null;

  return (
    <div className="bg-card border border-border rounded-xl overflow-hidden shadow-sm">
      <div className="overflow-x-auto">
        <table className="w-full text-left border-collapse min-w-max">
          <thead>
            <tr className="border-b border-border bg-card">
              <th className="p-4 font-semibold text-muted-foreground sticky left-0 bg-card z-10 w-48">Metric</th>
              {loadedTickers.map(ticker => (
                <th key={ticker} className="p-4 font-bold text-xl text-right">
                  <span className="font-mono">{ticker}</span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {/* Signal row — uses V2 gate when scoreMap available */}
            <tr className="border-b border-border/50">
              <td className="p-3 text-sm font-medium text-muted-foreground sticky left-0 bg-card">Signal</td>
              {loadedTickers.map(ticker => {
                const d = data[ticker];
                if (!d) return <td key={ticker} className="p-3 text-right text-muted-foreground">—</td>;
                const sig = scoreMap?.[ticker]?.signal ?? d.signal;
                const cls =
                  sig === "GO"    ? "text-green-400" :
                  sig === "WATCH" ? "text-yellow-400" :
                  "text-muted-foreground";
                return (
                  <td key={ticker} className={cn("p-3 text-right font-bold text-sm", cls)}>
                    {sig}
                  </td>
                );
              })}
            </tr>

            {/* RSI with threshold */}
            <tr className="border-b border-border/50 hover:bg-secondary/10 transition-colors">
              <td className="p-3 text-sm font-medium text-muted-foreground sticky left-0 bg-card group-hover:bg-card">RSI 14</td>
              {loadedTickers.map(ticker => {
                const d = data[ticker];
                if (!d) return <td key={ticker} className="p-3 text-right text-muted-foreground">—</td>;
                return (
                  <td key={ticker} className={cn("p-3 text-right font-mono text-sm font-semibold", d.rsiOk ? "text-green-400" : "text-red-400")}>
                    {d.rsi.toFixed(1)}<span className="text-muted-foreground/60 font-normal text-xs"> /{d.rsiThreshold}</span>
                  </td>
                );
              })}
            </tr>

            {/* MFI with threshold */}
            <tr className="border-b border-border/50 hover:bg-secondary/10 transition-colors">
              <td className="p-3 text-sm font-medium text-muted-foreground sticky left-0 bg-card">MFI 14</td>
              {loadedTickers.map(ticker => {
                const d = data[ticker];
                if (!d) return <td key={ticker} className="p-3 text-right text-muted-foreground">—</td>;
                return (
                  <td key={ticker} className={cn("p-3 text-right font-mono text-sm font-semibold", d.mfiOk ? "text-green-400" : "text-red-400")}>
                    {d.mfi.toFixed(1)}<span className="text-muted-foreground/60 font-normal text-xs"> /25</span>
                  </td>
                );
              })}
            </tr>

            {/* MACD */}
            <tr className="border-b border-border/50">
              <td className="p-3 text-sm font-medium text-muted-foreground sticky left-0 bg-card">MACD</td>
              {loadedTickers.map(ticker => {
                const d = data[ticker];
                if (!d || !d.macdCross) return <td key={ticker} className="p-3 text-right text-muted-foreground">—</td>;
                const isBull = d.macdCross.startsWith("BULLISH");
                const isCross = d.macdCross.endsWith("_CROSS");
                const label =
                  d.macdCross === "BULLISH_CROSS" ? "Bullish ×" :
                  d.macdCross === "BULLISH"        ? "Bullish"   :
                  d.macdCross === "BEARISH_CROSS"  ? "Bearish ×" : "Bearish";
                return (
                  <td key={ticker} className={cn("p-3 text-right font-mono text-sm font-semibold", isBull ? "text-green-400" : "text-red-400", isCross && "font-bold")}>
                    {label}
                  </td>
                );
              })}
            </tr>

            <TechRow
              label="Stoch %K" tickers={loadedTickers} data={data}
              getValue={d => d.stoch} lowerIsBetter
              format={v => v.toFixed(1)}
              colorFn={v => v < 20 ? "text-green-400" : v > 80 ? "text-red-400" : ""}
            />
            <TechRow
              label="52w Position" tickers={loadedTickers} data={data}
              getValue={d => d.position52w} lowerIsBetter
              format={v => `${v.toFixed(0)}%`}
              colorFn={v => v < 30 ? "text-green-400" : v > 70 ? "text-red-400" : ""}
            />
            <TechRow
              label="5d Return" tickers={loadedTickers} data={data}
              getValue={d => d.return5d} lowerIsBetter
              format={v => `${v > 0 ? "+" : ""}${v.toFixed(1)}%`}
              colorFn={v => v < 0 ? "text-green-400" : v > 5 ? "text-red-400" : ""}
            />
            <TechRow
              label="vs SPY 20d" tickers={loadedTickers} data={data}
              getValue={d => d.vsSpy20d} lowerIsBetter
              format={v => `${v > 0 ? "+" : ""}${v.toFixed(1)}%`}
              colorFn={v => v < 0 ? "text-green-400" : v > 5 ? "text-red-400" : ""}
            />
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ── Page ──────────────────────────────────────────────────────────────────────


interface TechnicalProps {
  tickers: string[];
  setTickers: Dispatch<SetStateAction<string[]>>;
}

export default function Technical({ tickers, setTickers }: TechnicalProps) {
  const { tickers: watchlistTickers } = useWatchlist();
  const [refreshing, setRefreshing] = useState<Set<string>>(new Set());

  const handleAdd    = (t: string) => { if (!tickers.includes(t) && tickers.length < MAX_SLOTS) setTickers(p => [...p, t]); };
  const handleRemove = (t: string) => setTickers(p => p.filter(x => x !== t));
  const focusInput   = () => document.querySelector<HTMLInputElement>('input[placeholder^="Add ticker"]')?.focus();

  // Fetch all 31 watchlist technicals for V2 scorer (stable ranks, self-relative scores)
  const { data: allTechnicalsData } = useQuery({
    queryKey: ["technicals", "all"],
    queryFn: async (): Promise<TechnicalRow[]> => {
      const res = await fetch("/api/technicals/all");
      if (!res.ok) throw new Error("technicals/all fetch failed");
      return res.json();
    },
    staleTime: 60 * 60 * 1000,  // 1h — server refreshes daily
    gcTime: 2 * 60 * 60 * 1000,
    refetchOnWindowFocus: false,
  });

  const queries = useQueries({
    queries: tickers.map(ticker => ({
      queryKey: ["indicators", ticker],
      queryFn: async (): Promise<IndicatorResult> => {
        const res = await fetch(`/api/indicators/${ticker}`);
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          throw new Error((body as any).error ?? `HTTP ${res.status}`);
        }
        return res.json();
      },
      staleTime: 4 * 60 * 1000,
      retry: 2,
      retryDelay: (attempt: number) => Math.min(attempt * 3000, 10000),
    })),
  });

  const loadingMap = useMemo(() => {
    const m: Record<string, boolean> = {};
    tickers.forEach((t, i) => { m[t] = queries[i]?.isLoading ?? false; });
    return m;
  }, [tickers, queries]);

  const errorMap = useMemo(() => {
    const m: Record<string, boolean> = {};
    tickers.forEach((t, i) => { m[t] = queries[i]?.isError ?? false; });
    return m;
  }, [tickers, queries]);

  const dataMap = useMemo(() => {
    const m: Record<string, IndicatorResult | null> = {};
    tickers.forEach((t, i) => { m[t] = (queries[i]?.data as IndicatorResult | null | undefined) ?? null; });
    return m;
  }, [tickers, queries]);

  // V2: self-relative scores computed over all 31 watchlist rows (invariant to shelf selection)
  const technicalScores = useMemo(() => {
    if (!allTechnicalsData?.length) return [];
    return computeTechnicalRankingsV2(allTechnicalsData);
  }, [allTechnicalsData]);

  const handleRefresh = async (ticker: string) => {
    setRefreshing(s => new Set(s).add(ticker));
    try {
      await queries[tickers.indexOf(ticker)]?.refetch?.();
    } finally {
      setRefreshing(s => { const n = new Set(s); n.delete(ticker); return n; });
    }
  };

  const hasData = tickers.some(t => dataMap[t] != null);

  return (
    <div className="min-h-[100dvh] bg-background text-foreground selection:bg-primary/30 flex">
      <Sidebar />

      <main className="flex-1 ml-[220px] min-w-0">
        <div className="p-5 border-b border-border/50 flex items-center justify-between gap-4 sticky top-0 bg-background/95 backdrop-blur z-40">
          <div>
            <h1 className="text-lg font-bold tracking-tight leading-none">Technical Scorecard</h1>
            <p className="text-xs text-muted-foreground mt-0.5">Self-relative V2 · RSI pct · MACD direction · IV vs realized · support proximity</p>
          </div>
          <TickerShelf
            tickers={tickers}
            loadingTickers={loadingMap}
            onAdd={handleAdd}
            onRemove={handleRemove}
            suggestions={watchlistTickers}
          />
        </div>

        <div className="p-5 space-y-4">
          <TechnicalCards
            tickers={tickers}
            data={dataMap}
            loading={loadingMap}
            errors={errorMap}
            scores={technicalScores}
            onAddClick={focusInput}
            onRemove={handleRemove}
            onRefresh={handleRefresh}
            refreshing={refreshing}
          />

          {technicalScores.length >= 2 && (
            <TechnicalLeaderboard
              scores={technicalScores}
              rowMap={allTechnicalsData ? Object.fromEntries(allTechnicalsData.map(r => [r.ticker, r])) : undefined}
            />
          )}
          {hasData && (
            <TechnicalMetricsTable tickers={tickers} data={dataMap} scoreMap={Object.fromEntries(technicalScores.map(s => [s.ticker, s]))} />
          )}
        </div>
      </main>
    </div>
  );
}
