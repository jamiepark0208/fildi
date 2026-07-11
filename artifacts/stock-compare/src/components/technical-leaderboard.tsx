import { useState } from "react";
import { useScoreExplanation } from "@/hooks/useScoreExplanation";
import { ChevronDown, Trophy } from "lucide-react";
import { cn } from "@/lib/utils";
import { type TechnicalScore, type TechnicalRow } from "@/lib/technical-rankings";

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

interface TechMetricRow { label: string; value: string; zScore: number; }

function techMetricLabel(key: string): string {
  return key.replace(/([A-Z])/g, " $1").replace(/^./, s => s.toUpperCase()).trim();
}

function techMetricValueStr(val: number): string {
  if (Math.abs(val) >= 1000) return val.toLocaleString("en-US", { maximumFractionDigits: 0 });
  if (Math.abs(val) >= 10) return val.toFixed(1);
  return val.toFixed(2);
}

function techZScoreColor(z: number): string {
  if (z >= 1.5) return "text-emerald-400";
  if (z >= 0.5) return "text-emerald-300/80";
  if (z <= -1.5) return "text-red-400";
  if (z <= -0.5) return "text-red-300/80";
  return "text-white/50";
}

// Only ever called for the single row the user expands — not on every render/row.
function buildTechMetricRows(score: TechnicalScore, allScores: TechnicalScore[]): TechMetricRow[] {
  const top = Object.entries(score.metricScores)
    .filter(([, v]) => v.value != null)
    .sort((a, b) => Math.abs(b[1].weightedScore) - Math.abs(a[1].weightedScore))
    .slice(0, 5);

  return top.map(([key, mv]) => {
    const rawVal = mv.value ?? 0;
    const peerVals = allScores
      .map(s => s.metricScores[key]?.value)
      .filter((v): v is number => v != null);
    const mean = peerVals.reduce((a, b) => a + b, 0) / peerVals.length;
    const std = Math.sqrt(peerVals.reduce((a, b) => a + (b - mean) ** 2, 0) / peerVals.length);
    return {
      label: techMetricLabel(key),
      value: techMetricValueStr(rawVal),
      zScore: std > 0 ? (rawVal - mean) / std : 0,
    };
  });
}

export function TechnicalLeaderboard({ scores, rowMap }: { scores: TechnicalScore[]; rowMap?: Record<string, TechnicalRow> }) {
  const { explain, getState } = useScoreExplanation();
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());

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

  return (
    <div className="bg-card border border-border rounded-xl p-4 shadow-sm">
      <div className="flex items-center gap-2 mb-3">
        <Trophy className="w-4 h-4 text-primary" />
        <h2 className="text-sm font-bold tracking-tight">Technical Rankings Leaderboard</h2>
      </div>

      <div className="flex flex-col gap-0.5">
        {scores.map((score, idx) => {
          const state      = getState(score.ticker, "technical");
          const isLoading  = state.status === "loading";
          const bullets    = state.status === "done" ? parseBullets(state.text) : [];
          const isExpanded = state.status === "done" && bullets.length > 0 && !collapsed.has(score.ticker);
          const metricRows = isExpanded ? buildTechMetricRows(score, scores) : [];

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
                <div className="mt-2.5 mb-1 pl-9 space-y-2.5">
                  {metricRows.length > 0 && (
                    <table className="w-full text-[11px] border-collapse">
                      <thead>
                        <tr className="border-b border-white/10">
                          <th className="text-left pb-1 text-white/40 font-medium">Metric</th>
                          <th className="text-right pb-1 text-white/40 font-medium pr-3">Value</th>
                          <th className="text-right pb-1 text-white/40 font-medium">vs Peers</th>
                        </tr>
                      </thead>
                      <tbody>
                        {metricRows.map((row, i) => (
                          <tr key={i} className="border-b border-white/5 last:border-0">
                            <td className="py-1 text-white/80">{row.label}</td>
                            <td className="py-1 pr-3 text-right font-mono text-white/70">{row.value}</td>
                            <td className={cn("py-1 text-right font-mono font-semibold", techZScoreColor(row.zScore))}>
                              {row.zScore >= 0 ? "+" : ""}{row.zScore.toFixed(1)}σ
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )}

                  <ul className="space-y-0.5">
                    {bullets.map((b, i) => (
                      <li key={i} className="flex items-start gap-1.5 text-xs text-white leading-snug">
                        <span className="text-slate-500 shrink-0 mt-0.5">•</span>
                        {b}
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
