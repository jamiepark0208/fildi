import { useState } from "react";
import { StockScore } from "@/lib/rankings";
import { Trophy } from "lucide-react";
import { cn } from "@/lib/utils";

interface RankingsLeaderboardProps {
  scores: StockScore[];
}

export function RankingsLeaderboard({ scores }: RankingsLeaderboardProps) {
  const [explanations, setExplanations] = useState<Map<string, string>>(new Map());
  const [loading,      setLoading]      = useState<Set<string>>(new Set());
  const [expanded,     setExpanded]     = useState<Set<string>>(new Set());

  async function fetchExplanation(score: StockScore) {
    const { ticker } = score;

    // Already fetched — just toggle visibility
    if (explanations.has(ticker)) {
      setExpanded(prev => {
        const next = new Set(prev);
        next.has(ticker) ? next.delete(ticker) : next.add(ticker);
        return next;
      });
      return;
    }

    const metricEntries = Object.entries(score.metricScores)
      .filter(([, v]) => v.value != null)
      .sort((a, b) => b[1].weightedScore - a[1].weightedScore);
    const topMetrics  = metricEntries.slice(0, 3).map(([k]) => k);
    const weakMetrics = metricEntries.slice(-3).map(([k]) => k);
    const fs = score.familyScores;

    setLoading(prev => new Set(prev).add(ticker));
    try {
      const res = await fetch("/api/explain/score", {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ticker,
          scoreType: "fundamental",
          fundamentalData: {
            totalScore:     score.totalScore,
            rank:           score.rank,
            familyScores: {
              value:   fs?.value.score   ?? 50,
              growth:  fs?.growth.score  ?? 50,
              quality: fs?.quality.score ?? 50,
              safety:  fs?.safety.score  ?? 50,
            },
            topMetrics,
            weakMetrics,
            reason:         score.reason,
            suspectMetrics: score.suspectMetrics,
            dataQuality:    score.dataQuality,
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

  return (
    <div className="bg-card border border-border rounded-xl p-6 shadow-sm">
      <div className="flex items-center gap-2 mb-6">
        <Trophy className="w-5 h-5 text-primary" />
        <h2 className="text-lg font-bold tracking-tight">Rankings Leaderboard</h2>
      </div>

      <div className="flex flex-col gap-4">
        {scores.map((score, idx) => {
          const isGold   = idx === 0;
          const isSilver = idx === 1;
          const isBronze = idx === 2;
          const isLoading    = loading.has(score.ticker);
          const explanation  = explanations.get(score.ticker);
          const isExpanded   = expanded.has(score.ticker);

          return (
            <div
              key={score.ticker}
              className={cn(
                "relative p-4 rounded-lg border overflow-hidden",
                isGold   ? "border-yellow-500/50 bg-yellow-500/10" :
                isSilver ? "border-slate-400/50 bg-slate-400/10"   :
                isBronze ? "border-amber-700/50 bg-amber-700/10"   :
                "border-border bg-background/50"
              )}
            >
              <div className="flex items-start justify-between">
                <div className="flex items-start gap-4 z-10">
                  <div className={cn(
                    "w-8 h-8 rounded-full flex items-center justify-center font-bold text-sm shrink-0 mt-0.5",
                    isGold   ? "bg-yellow-500 text-yellow-950" :
                    isSilver ? "bg-slate-400 text-slate-950"   :
                    isBronze ? "bg-amber-700 text-amber-50"    :
                    "bg-secondary text-secondary-foreground"
                  )}>
                    #{score.rank}
                  </div>
                  <div>
                    <div className="font-mono font-bold text-lg leading-none">{score.ticker}</div>
                    <div className="text-xs text-muted-foreground truncate max-w-[160px] sm:max-w-[240px]">
                      {score.companyName}
                    </div>
                    {score.reason && (
                      <div className="text-xs text-muted-foreground/70 mt-0.5 italic max-w-[280px]">
                        {score.reason}
                      </div>
                    )}
                    <button
                      onClick={() => fetchExplanation(score)}
                      disabled={isLoading}
                      className="text-xs text-muted-foreground hover:text-foreground transition-colors mt-1 disabled:opacity-50"
                    >
                      {isLoading ? "Generating…" : explanation ? (isExpanded ? "Explain ▴" : "Explain ▾") : "Explain ▾"}
                    </button>
                    {isExpanded && explanation && (
                      <div className="mt-1.5 pl-3 border-l-2 border-border/60 text-xs text-muted-foreground/80 italic leading-relaxed max-w-[340px]">
                        {explanation}
                      </div>
                    )}
                  </div>
                </div>

                <div className="text-right z-10 flex flex-col items-end shrink-0 ml-4">
                  <div className="font-bold text-lg leading-none mb-1">
                    {score.totalScore.toFixed(2)} pts
                  </div>
                  <div className="w-24 h-1.5 bg-background rounded-full overflow-hidden">
                    <div
                      className={cn(
                        "h-full rounded-full",
                        isGold   ? "bg-yellow-500" :
                        isSilver ? "bg-slate-400"   :
                        isBronze ? "bg-amber-700"   :
                        "bg-primary"
                      )}
                      style={{ width: `${(score.totalScore / scores[0].totalScore) * 100}%` }}
                    />
                  </div>
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
