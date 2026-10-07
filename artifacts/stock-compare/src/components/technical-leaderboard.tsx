import { Fragment, useState, useMemo } from "react";
import { useScoreExplanation } from "@/hooks/useScoreExplanation";
import { ChevronDown, Trophy, Search } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  type TechnicalScore, type TechnicalRow, type ScoreSide,
  getTechnicalScorecardMetrics, getComponentExplainers,
} from "@/lib/technical-rankings";
import { GRID_WRAP, GRID_HEADER, GRID_TH, GRID_TD, gridRow, ROW_CELL, percentileColor, percentileBadge, highlightBullet } from "@/lib/score-explain-format";
import { formatMdYy } from "@/lib/format";

function buildTechnicalPayload(score: TechnicalScore, rowMap?: Record<string, TechnicalRow>, side: ScoreSide = "put") {
  const row = rowMap?.[score.ticker];
  const cs  = score.componentScores ?? {};
  return {
    technicalData: {
      // Lens the score was computed under: "put" = oversold/sell-puts, "call" = overbought/sell-calls
      side,
      totalScore:      score.totalScore,
      rank:            score.rank,
      signal:          score.signal,
      regime:          score.regime ?? "NEUTRAL",
      componentScores: {
        oversoldDepth:    cs["oversoldDepth"]?.score    ?? 0,
        reversalSignal:   cs["reversalSignal"]?.score   ?? 0,
        volatilityState:  cs["volatilityState"]?.score  ?? 0,
        trendContext:     cs["trendContext"]?.score     ?? 0,
        relativePressure: cs["relativePressure"]?.score ?? 0,
        optionsFlow:      cs["optionsFlow"]?.score      ?? 0,
        analystUpside:    cs["analystUpside"]?.score    ?? 0,
        volumeConfirm:    cs["volumeConfirm"]?.score   ?? 0,
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
  };
}

function parseBullets(text: string): string[] {
  return text
    .split(/\n|(?<=[.!?])\s{1,2}(?=[A-Z•\-])/)
    .map(s => s.replace(/^[-•*]\s*/, "").trim())
    .filter(s => s.length > 8);
}

export function TechnicalLeaderboard({
  scores,
  rowMap,
  side = "put",
  scoredAsOf,
}: {
  scores: TechnicalScore[];
  rowMap?: Record<string, TechnicalRow>;
  side?: ScoreSide;
  /** ISO timestamp — typically max(technicalsLastFetched) across scored rows. */
  scoredAsOf?: string | null;
}) {
  // Side-aware labels/explainers — same component keys, direction-correct wording.
  const metrics = getTechnicalScorecardMetrics(side);
  const explainers = getComponentExplainers(side);
  const componentLabel: Record<string, string> = Object.fromEntries(metrics.map(m => [m.key, m.label]));
  const { explain, getState } = useScoreExplanation();
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [query, setQuery] = useState("");

  if (scores.length < 2) return null;

  const maxScore = scores[0].totalScore;
  const filtered = query.trim()
    ? scores.filter(s => s.ticker.toLowerCase().includes(query.trim().toLowerCase()))
    : scores;

  const scoredLabel = (() => {
    let iso = scoredAsOf ?? null;
    if (!iso && rowMap) {
      let maxMs = 0;
      for (const r of Object.values(rowMap)) {
        const t = r.technicalsLastFetched;
        if (!t) continue;
        const ms = new Date(t).getTime();
        if (Number.isFinite(ms) && ms > maxMs) maxMs = ms;
      }
      if (maxMs > 0) iso = new Date(maxMs).toISOString();
    }
    if (!iso) return null;
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return null;
    return formatMdYy(iso);
  })();

  const rankBadgeCls = (idx: number) =>
    idx === 0 ? "bg-yellow-500 text-yellow-950" :
    idx === 1 ? "bg-slate-400 text-slate-950"   :
    idx === 2 ? "bg-amber-700 text-amber-50"    :
                "bg-secondary text-secondary-foreground";

  const rowCls = (idx: number) =>
    idx === 0 ? "border-yellow-500/30 bg-yellow-500/10" :
    idx === 1 ? "border-slate-400/30 bg-slate-400/10"   :
    idx === 2 ? "border-amber-700/30 bg-amber-700/10"   :
                "border-[#d4af37]/10 bg-transparent";

  return (
    <div className="bg-zinc-950 border border-[#d4af37]/20 rounded-lg p-4 shadow-lg shadow-black/60">
      <div className="flex items-center justify-between gap-2 mb-3">
        <div className="flex items-center gap-2">
          <Trophy className="w-4 h-4 text-primary" />
          <h2 className="text-sm font-bold tracking-tight">Technical Rankings Leaderboard</h2>
          <span className="text-xs text-muted-foreground">({scores.length})</span>
          {scoredLabel && (
            <span className="text-[10px] text-muted-foreground/80" title="max technicals_last_fetched">
              {scoredLabel}
            </span>
          )}
        </div>
        <div className="relative">
          <Search className="w-3.5 h-3.5 text-gray-500 absolute left-2 top-1/2 -translate-y-1/2" />
          <input
            type="text"
            value={query}
            onChange={e => setQuery(e.target.value)}
            placeholder="Filter ticker..."
            className="h-7 w-36 pl-7 pr-2 text-xs rounded-md border border-white/20 bg-white text-black placeholder:text-gray-500 focus:outline-none focus:ring-2 focus:ring-primary"
          />
        </div>
      </div>

      <div className={GRID_WRAP}>
        <table className="w-full border-collapse">
          <thead>
            <tr className={GRID_HEADER}>
              <th className={cn(GRID_TH, "text-center w-8")}>#</th>
              <th className={cn(GRID_TH, "text-left")}>Ticker</th>
              <th className={cn(GRID_TH, "text-center w-14")}>Gate</th>
              <th className={cn(GRID_TH, "text-right")}>Score</th>
              <th className={cn(GRID_TH, "text-left")}>Strength</th>
              <th className={cn(GRID_TH, "text-right")}></th>
            </tr>
          </thead>
          <tbody>
        {filtered.length === 0 && (
          <tr><td colSpan={6} className="text-xs text-muted-foreground py-2 px-2.5">No tickers match "{query}".</td></tr>
        )}
        {filtered.map((score, rowIdx) => {
          const idx = score.rank - 1;
          const state      = getState(score.ticker, "technical", `technical-${side}`);
          const isLoading  = state.status === "loading";
          const bullets    = state.status === "done" ? parseBullets(state.text) : [];
          const isExpanded = state.status === "done" && bullets.length > 0 && !collapsed.has(score.ticker);

          const row = rowMap?.[score.ticker];
          const componentRows = isExpanded
            ? metrics.map(m => {
                const cs = score.componentScores?.[m.key];
                const s01 = cs?.score ?? null;
                const weight = cs?.weight ?? m.weight;
                return {
                  key: m.key,
                  label: m.label,
                  score100: s01 != null ? s01 * 100 : null,
                  weightPct: Math.round(weight * 100),
                  contribution: s01 != null ? s01 * weight * 100 : 0,
                };
              })
            : [];
          const availWeightSum = componentRows.filter(c => c.score100 != null).reduce((s, c) => s + c.weightPct, 0);

          return (
            <Fragment key={score.ticker}>
            <tr
              className={cn(idx < 3 ? rowCls(idx) : gridRow(rowIdx), "align-middle cursor-pointer")}
              onClick={() => {
                if (isLoading) return;
                if (state.status === "done") {
                  setCollapsed(prev => {
                    const next = new Set(prev);
                    if (next.has(score.ticker)) next.delete(score.ticker);
                    else next.add(score.ticker);
                    return next;
                  });
                } else {
                  explain(score.ticker, "technical", buildTechnicalPayload(score, rowMap, side), `technical-${side}`);
                }
              }}
            >
              <td className={cn(GRID_TD, "text-center")}>
                <span className={cn(
                  "inline-flex w-5 h-5 rounded-full items-center justify-center font-bold text-[10px]",
                  rankBadgeCls(idx)
                )}>
                  {score.rank}
                </span>
              </td>

              <td className={GRID_TD}>
                <span className="font-mono font-bold text-white">{score.ticker}</span>
              </td>

              <td className={cn(GRID_TD, "text-center")}>
                <span
                  className={cn(
                    "inline-flex px-1.5 py-0.5 rounded text-[10px] font-bold tracking-wide",
                    score.signal === "GO" && "bg-emerald-500/20 text-emerald-400",
                    score.signal === "WATCH" && "bg-amber-500/20 text-amber-300",
                    score.signal === "NO" && "bg-slate-700/60 text-slate-400",
                  )}
                  title={score.reason}
                >
                  {score.signal}
                </span>
              </td>

              <td className={cn(GRID_TD, "text-right")}>
                <span className="font-mono font-bold text-white">{score.totalScore.toFixed(1)}</span>
              </td>

              <td className={cn(GRID_TD, "w-32")}>
                <div className="h-1.5 w-24 bg-slate-800 rounded-full overflow-hidden">
                  <div
                    className={cn(
                      "h-full rounded-full",
                      idx === 0 ? "bg-yellow-500" : idx === 1 ? "bg-slate-400" : idx === 2 ? "bg-amber-700" : "bg-primary/60"
                    )}
                    style={{ width: `${(score.totalScore / maxScore) * 100}%` }}
                  />
                </div>
              </td>

              <td className={cn(GRID_TD, "text-right")}>
                <span className={cn("inline-flex items-center gap-1 text-[11px] text-slate-400 transition-colors", isLoading && "opacity-50")}>
                  {isLoading ? "…" : "Why"}
                  <ChevronDown className={cn("w-3 h-3 transition-transform", isExpanded && "rotate-180")} />
                </span>
              </td>
            </tr>

              {isExpanded && (
                <tr>
                <td colSpan={6} className="p-0">
                <div className="px-3 pl-9 py-1.5 space-y-1.5 bg-black/50 border-b border-[#d4af37]/15">
                  {/* Formula breakdown, one line: Total = Σ(component score × weight), renormalized over available weight */}
                  {componentRows.length > 0 && (
                    <div className="flex items-center flex-wrap gap-x-1.5 gap-y-0.5 text-[11px] font-mono">
                      <span className="text-white/30 uppercase tracking-widest text-[9px] mr-0.5">{score.regime ?? "NEUTRAL"}</span>
                      {componentRows.map((r, i) => (
                        <span key={r.key} className="flex items-center gap-1">
                          {i > 0 && <span className="text-white/20">+</span>}
                          <span className="text-white/60">{r.label}</span>
                          <span className={r.score100 != null ? percentileColor(r.score100) : "text-white/30"}>
                            {r.score100 != null ? r.score100.toFixed(0) : "n/a"}
                          </span>
                          <span className="text-white/30">×{r.weightPct}%</span>
                          <span className="text-white/70">{r.score100 != null ? `=+${r.contribution.toFixed(1)}` : ""}</span>
                        </span>
                      ))}
                      <span className="text-white/20">·</span>
                      <span className="text-white/50">÷{availWeightSum}%</span>
                      <span className="text-white/20">=</span>
                      <span className="font-bold text-white">{score.totalScore.toFixed(1)}</span>
                    </div>
                  )}

                  {/* Sub-metric breakdown: the literal inputs feeding each component score above */}
                  {row && (
                    <div>
                      <p className="text-[9px] uppercase tracking-widest text-white/30 mb-0.5">Inputs (self-relative to {score.ticker}'s own history)</p>
                      <div className={GRID_WRAP}>
                        <table className="w-full border-collapse">
                          <thead>
                            <tr className={GRID_HEADER}>
                              <th className={cn(GRID_TH, "text-left py-0.5")}>Component</th>
                              <th className={cn(GRID_TH, "text-left py-0.5")}>Input</th>
                              <th className={cn(GRID_TH, "text-right py-0.5")}>Raw</th>
                              <th className={cn(GRID_TH, "text-right py-0.5")}>Score</th>
                            </tr>
                          </thead>
                          <tbody>
                            {(() => {
                              let flatIdx = 0;
                              return Object.entries(explainers).flatMap(([key, fn]) => {
                                const parts = fn(row);
                                return parts.map((part, pi) => {
                                  const tr = (
                                    <tr key={`${key}-${pi}`} className={gridRow(flatIdx)}>
                                      {pi === 0 ? (
                                        <td className={cn(GRID_TD, ROW_CELL, "text-left text-white/50 font-medium")} rowSpan={parts.length}>
                                          {componentLabel[key] ?? key}
                                        </td>
                                      ) : null}
                                      <td className={cn(GRID_TD, ROW_CELL, "text-left text-white/70")}>{part.label}</td>
                                      <td className={cn(GRID_TD, ROW_CELL, "text-right font-mono text-white/60")}>{part.raw}</td>
                                      <td className={cn(GRID_TD, ROW_CELL, "text-right font-mono font-semibold", percentileColor(part.score * 100))}>
                                        {(part.score * 100).toFixed(0)}
                                      </td>
                                    </tr>
                                  );
                                  flatIdx++;
                                  return tr;
                                });
                              });
                            })()}
                          </tbody>
                        </table>
                      </div>
                    </div>
                  )}

                  <ul className="space-y-0.5">
                    {bullets.map((b, i) => (
                      <li key={i} className="flex items-start gap-1.5 text-xs text-white leading-snug">
                        <span className="text-slate-500 shrink-0 mt-0.5">•</span>
                        <span>{highlightBullet(b)}</span>
                      </li>
                    ))}
                  </ul>
                  <p className="text-[10px] text-slate-500">AI narrative — not a trade recommendation.</p>
                </div>
                </td>
                </tr>
              )}
            </Fragment>
          );
        })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
