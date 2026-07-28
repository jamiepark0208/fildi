import { useState } from "react";
import { useScoreExplanation } from "@/hooks/useScoreExplanation";
import { ChevronDown, Trophy, Search } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  type TechnicalScore, type TechnicalRow, TECHNICAL_SCORECARD_METRICS_V2, COMPONENT_EXPLAINERS,
} from "@/lib/technical-rankings";
import { GRID_WRAP, GRID_HEADER, GRID_TH, GRID_TD, gridRow, percentileColor, percentileBadge, highlightBullet } from "@/lib/score-explain-format";

const COMPONENT_LABEL: Record<string, string> = Object.fromEntries(
  TECHNICAL_SCORECARD_METRICS_V2.map(m => [m.key, m.label]),
);

function buildTechnicalPayload(score: TechnicalScore, rowMap?: Record<string, TechnicalRow>) {
  const row = rowMap?.[score.ticker];
  const cs  = score.componentScores ?? {};
  return {
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
  };
}

function parseBullets(text: string): string[] {
  return text
    .split(/\n|(?<=[.!?])\s{1,2}(?=[A-Z•\-])/)
    .map(s => s.replace(/^[-•*]\s*/, "").trim())
    .filter(s => s.length > 8);
}

export function TechnicalLeaderboard({ scores, rowMap }: { scores: TechnicalScore[]; rowMap?: Record<string, TechnicalRow> }) {
  const { explain, getState } = useScoreExplanation();
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [query, setQuery] = useState("");

  if (scores.length < 2) return null;

  const maxScore = scores[0].totalScore;
  const filtered = query.trim()
    ? scores.filter(s => s.ticker.toLowerCase().includes(query.trim().toLowerCase()))
    : scores;

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

  return (
    <div className="bg-card border border-border rounded-xl p-4 shadow-sm">
      <div className="flex items-center justify-between gap-2 mb-3">
        <div className="flex items-center gap-2">
          <Trophy className="w-4 h-4 text-primary" />
          <h2 className="text-sm font-bold tracking-tight">Technical Rankings Leaderboard</h2>
          <span className="text-xs text-muted-foreground">({scores.length})</span>
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

      <div className="flex flex-col gap-0.5">
        {filtered.length === 0 && (
          <p className="text-xs text-muted-foreground py-2">No tickers match "{query}".</p>
        )}
        {filtered.map((score) => {
          const idx = score.rank - 1;
          const state      = getState(score.ticker, "technical");
          const isLoading  = state.status === "loading";
          const bullets    = state.status === "done" ? parseBullets(state.text) : [];
          const isExpanded = state.status === "done" && bullets.length > 0 && !collapsed.has(score.ticker);

          const row = rowMap?.[score.ticker];
          const componentRows = isExpanded
            ? TECHNICAL_SCORECARD_METRICS_V2.map(m => {
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
                  onClick={() => {
                    if (state.status === "done") {
                      setCollapsed(prev => {
                        const next = new Set(prev);
                        if (next.has(score.ticker)) next.delete(score.ticker);
                        else next.add(score.ticker);
                        return next;
                      });
                    } else {
                      explain(score.ticker, "technical", buildTechnicalPayload(score, rowMap));
                    }
                  }}
                  disabled={isLoading}
                  className="flex items-center gap-1 text-[11px] text-slate-400 hover:text-white transition-colors shrink-0 disabled:opacity-50"
                >
                  {isLoading ? "…" : "Why"}
                  <ChevronDown className={cn("w-3 h-3 transition-transform", isExpanded && "rotate-180")} />
                </button>
              </div>

              {isExpanded && (
                <div className="mt-2.5 mb-1 pl-9 space-y-3">
                  {/* Formula breakdown: Total = Σ(component score × weight), renormalized over available weight */}
                  {componentRows.length > 0 && (
                    <div>
                      <p className="text-[10px] uppercase tracking-widest text-white/40 mb-1">
                        Score Formula — {score.regime ?? "NEUTRAL"} regime
                      </p>
                      <div className={GRID_WRAP}>
                        <table className="w-full border-collapse">
                          <thead>
                            <tr className={GRID_HEADER}>
                              <th className={cn(GRID_TH, "text-left")}>Component</th>
                              <th className={cn(GRID_TH, "text-right")}>Score</th>
                              <th className={cn(GRID_TH, "text-right")}>Weight</th>
                              <th className={cn(GRID_TH, "text-right")}>Contribution</th>
                            </tr>
                          </thead>
                          <tbody>
                            {componentRows.map((r, i) => (
                              <tr key={r.key} className={gridRow(i)}>
                                <td className={cn(GRID_TD, "text-left text-white/80")}>{r.label}</td>
                                <td className={cn(GRID_TD, "text-right font-mono", r.score100 != null ? percentileColor(r.score100) : "text-white/30")}>
                                  {r.score100 != null ? r.score100.toFixed(0) : "n/a"}
                                </td>
                                <td className={cn(GRID_TD, "text-right font-mono text-white/50")}>{r.weightPct}%</td>
                                <td className={cn(GRID_TD, "text-right font-mono text-white/80")}>
                                  {r.score100 != null ? `+${r.contribution.toFixed(1)}` : "—"}
                                </td>
                              </tr>
                            ))}
                            <tr className="bg-primary/10 border-t border-border/60">
                              <td className={cn(GRID_TD, "text-left font-semibold text-white")}>Total</td>
                              <td className={GRID_TD}></td>
                              <td className={cn(GRID_TD, "text-right font-mono text-white/50")}>÷{availWeightSum}%</td>
                              <td className={cn(GRID_TD, "text-right font-mono font-bold text-white")}>{score.totalScore.toFixed(1)}</td>
                            </tr>
                          </tbody>
                        </table>
                      </div>
                    </div>
                  )}

                  {/* Sub-metric breakdown: the literal inputs feeding each component score above */}
                  {row && (
                    <div>
                      <p className="text-[10px] uppercase tracking-widest text-white/40 mb-1">Inputs (self-relative to {score.ticker}'s own history)</p>
                      <div className={GRID_WRAP}>
                        <table className="w-full border-collapse">
                          <thead>
                            <tr className={GRID_HEADER}>
                              <th className={cn(GRID_TH, "text-left")}>Component</th>
                              <th className={cn(GRID_TH, "text-left")}>Input</th>
                              <th className={cn(GRID_TH, "text-right")}>Raw</th>
                              <th className={cn(GRID_TH, "text-right")}>Mapped Score</th>
                            </tr>
                          </thead>
                          <tbody>
                            {(() => {
                              let flatIdx = 0;
                              return Object.entries(COMPONENT_EXPLAINERS).flatMap(([key, fn]) => {
                                const parts = fn(row);
                                return parts.map((part, pi) => {
                                  const tr = (
                                    <tr key={`${key}-${pi}`} className={gridRow(flatIdx)}>
                                      {pi === 0 ? (
                                        <td className={cn(GRID_TD, "text-left text-white/50 font-medium")} rowSpan={parts.length}>
                                          {COMPONENT_LABEL[key] ?? key}
                                        </td>
                                      ) : null}
                                      <td className={cn(GRID_TD, "text-left text-white/70")}>{part.label}</td>
                                      <td className={cn(GRID_TD, "text-right font-mono text-white/60")}>{part.raw}</td>
                                      <td className={cn(GRID_TD, "text-right font-mono font-semibold", percentileColor(part.score * 100))}>
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
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
