import { useState, useCallback, memo } from "react";
import { StockScore } from "@/lib/rankings";
import { StockMetrics } from "@workspace/api-client-react";
import { Trophy, ChevronDown } from "lucide-react";
import { cn } from "@/lib/utils";

interface RankingsLeaderboardProps {
  scores: StockScore[];
  stocks?: StockMetrics[];
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

interface LeaderboardRowProps {
  score: StockScore;
  idx: number;
  maxScore: number;
  isLoading: boolean;
  explanation: string | undefined;
  isExpanded: boolean;
  onFetch: (score: StockScore) => void;
}

const LeaderboardRow = memo(function LeaderboardRow({
  score, idx, maxScore, isLoading, explanation, isExpanded, onFetch,
}: LeaderboardRowProps) {
  const bullets = explanation ? parseBullets(explanation) : [];
  return (
    <div className={cn("rounded-md border px-3 py-1.5", ROW_STYLE(idx))}>
      <div className="flex items-center gap-3">
        <div className={cn(
          "w-6 h-6 rounded-full flex items-center justify-center font-bold text-[11px] shrink-0",
          RANK_STYLE(idx)
        )}>
          {score.rank}
        </div>

        <div className="w-[88px] shrink-0">
          <span className="font-mono font-bold text-sm text-white">{score.ticker}</span>
          <span className="block text-xs text-white/60 truncate max-w-[84px]">{score.companyName}</span>
        </div>

        <div className="w-[56px] shrink-0 text-right">
          <span className="font-mono font-bold text-sm text-white">{score.totalScore.toFixed(1)}</span>
          <span className="text-xs text-white/50"> pts</span>
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
          onClick={() => onFetch(score)}
          disabled={isLoading}
          className="flex items-center gap-1.5 text-xs font-semibold text-white/80 hover:text-white transition-colors shrink-0 disabled:opacity-50"
        >
          {isLoading ? "…" : "Why"}
          <ChevronDown className={cn("w-3 h-3 transition-transform", isExpanded && "rotate-180")} />
        </button>
      </div>

      {isExpanded && bullets.length > 0 && (
        <ul className="mt-2.5 mb-1 pl-9 space-y-1.5">
          {bullets.map((b, i) => (
            <li key={i} className="flex items-start gap-2 text-sm text-white leading-relaxed">
              <span className="text-white/50 shrink-0 mt-0.5">•</span>
              {b}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
});

export function RankingsLeaderboard({ scores, stocks }: RankingsLeaderboardProps) {
  const [explanations, setExplanations] = useState<Record<string, string>>({});
  const [loading,      setLoading]      = useState<Record<string, boolean>>({});
  const [expanded,     setExpanded]     = useState<Record<string, boolean>>({});

  const fetchExplanation = useCallback(async (score: StockScore) => {
    const { ticker } = score;
    if (explanations[ticker] !== undefined) {
      setExpanded(prev => ({ ...prev, [ticker]: !prev[ticker] }));
      return;
    }

    const metricEntries = Object.entries(score.metricScores)
      .filter(([, v]) => v.value != null)
      .sort((a, b) => b[1].weightedScore - a[1].weightedScore);
    const topMetrics  = metricEntries.slice(0, 4).map(([k]) => k);
    const weakMetrics = metricEntries.slice(-4).map(([k]) => k);
    const fs = score.familyScores;
    const stockData = stocks?.find(s => s.ticker === ticker);
    const metricValues = Object.fromEntries(metricEntries.map(([k, v]) => [k, v.value]));

    setLoading(prev => ({ ...prev, [ticker]: true }));
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
            sector:   stockData?.sector   ?? undefined,
            industry: stockData?.industry ?? undefined,
            metricValues,
          },
        }),
      });
      const data = await res.json() as { explanation?: string };
      setExplanations(prev => ({ ...prev, [ticker]: data.explanation ?? "" }));
      setExpanded(prev => ({ ...prev, [ticker]: true }));
    } catch {
      setExplanations(prev => ({ ...prev, [ticker]: "Unable to generate explanation at this time." }));
      setExpanded(prev => ({ ...prev, [ticker]: true }));
    } finally {
      setLoading(prev => ({ ...prev, [ticker]: false }));
    }
  }, [explanations, stocks]);

  if (scores.length < 2) return null;
  const maxScore = scores[0].totalScore;

  return (
    <div className="bg-card border border-border rounded-xl p-4 shadow-sm">
      <div className="flex items-center gap-2 mb-3">
        <Trophy className="w-4 h-4 text-primary" />
        <h2 className="text-sm font-bold tracking-tight">Rankings Leaderboard</h2>
      </div>

      <div className="flex flex-col gap-0.5">
        {scores.map((score, idx) => (
          <LeaderboardRow
            key={score.ticker}
            score={score}
            idx={idx}
            maxScore={maxScore}
            isLoading={!!loading[score.ticker]}
            explanation={explanations[score.ticker]}
            isExpanded={!!expanded[score.ticker]}
            onFetch={fetchExplanation}
          />
        ))}
      </div>
    </div>
  );
}
