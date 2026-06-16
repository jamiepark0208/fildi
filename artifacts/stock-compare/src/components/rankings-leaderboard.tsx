import { useState } from "react";
import { StockScore } from "@/lib/rankings";
import { Trophy, ChevronDown } from "lucide-react";
import { cn } from "@/lib/utils";

interface RankingsLeaderboardProps {
  scores: StockScore[];
}

function parseBullets(text: string): string[] {
  return text
    .split(/\n|(?<=[.!?])\s{1,2}(?=[A-Z•\-])/)
    .map(s => s.replace(/^[-•*]\s*/, "").trim())
    .filter(s => s.length > 8);
}

const RANK_STYLE = (idx: number) =>
  idx === 0 ? "bg-yellow-500 text-yellow-950" :
  idx === 1 ? "bg-slate-400 text-slate-950"   :
  idx === 2 ? "bg-amber-700 text-amber-50"    :
              "bg-secondary text-secondary-foreground";

const ROW_STYLE = (idx: number) =>
  idx === 0 ? "border-yellow-500/30 bg-yellow-500/5" :
  idx === 1 ? "border-slate-400/30 bg-slate-400/5"   :
  idx === 2 ? "border-amber-700/30 bg-amber-700/5"   :
              "border-border/40 bg-background/30";

export function RankingsLeaderboard({ scores }: RankingsLeaderboardProps) {
  const [explanations, setExplanations] = useState<Map<string, string>>(new Map());
  const [loading,      setLoading]      = useState<Set<string>>(new Set());
  const [expanded,     setExpanded]     = useState<Set<string>>(new Set());

  async function fetchExplanation(score: StockScore) {
    const { ticker } = score;
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
            totalScore: score.totalScore, rank: score.rank,
            familyScores: {
              value:   fs?.value.score   ?? 50,
              growth:  fs?.growth.score  ?? 50,
              quality: fs?.quality.score ?? 50,
              safety:  fs?.safety.score  ?? 50,
            },
            topMetrics, weakMetrics,
            reason: score.reason,
            suspectMetrics: score.suspectMetrics,
            dataQuality: score.dataQuality,
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

  return (
    <div className="bg-card border border-border rounded-xl p-4 shadow-sm">
      <div className="flex items-center gap-2 mb-3">
        <Trophy className="w-4 h-4 text-primary" />
        <h2 className="text-sm font-bold tracking-tight">Rankings Leaderboard</h2>
      </div>

      <div className="flex flex-col gap-0.5">
        {scores.map((score, idx) => {
          const isLoading   = loading.has(score.ticker);
          const explanation = explanations.get(score.ticker);
          const isExpanded  = expanded.has(score.ticker);
          const bullets     = explanation ? parseBullets(explanation) : [];

          return (
            <div key={score.ticker} className={cn("rounded-md border px-3 py-1.5", ROW_STYLE(idx))}>
              <div className="flex items-center gap-3">
                {/* Rank badge */}
                <div className={cn(
                  "w-6 h-6 rounded-full flex items-center justify-center font-bold text-[11px] shrink-0",
                  RANK_STYLE(idx)
                )}>
                  {score.rank}
                </div>

                {/* Ticker + name */}
                <div className="w-[88px] shrink-0">
                  <span className="font-mono font-bold text-sm text-white">{score.ticker}</span>
                  <span className="block text-[10px] text-slate-400 truncate max-w-[84px]">{score.companyName}</span>
                </div>

                {/* Score */}
                <div className="w-[56px] shrink-0 text-right">
                  <span className="font-mono font-bold text-sm text-white">{score.totalScore.toFixed(1)}</span>
                  <span className="text-[10px] text-slate-500"> pts</span>
                </div>

                {/* Bar */}
                <div className="flex-1 h-1.5 bg-slate-800 rounded-full overflow-hidden">
                  <div
                    className={cn(
                      "h-full rounded-full",
                      idx === 0 ? "bg-yellow-500" : idx === 1 ? "bg-slate-400" : idx === 2 ? "bg-amber-700" : "bg-primary/60"
                    )}
                    style={{ width: `${(score.totalScore / maxScore) * 100}%` }}
                  />
                </div>

                {/* Explain toggle */}
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
