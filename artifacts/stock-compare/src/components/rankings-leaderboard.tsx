import { StockScore } from "@/lib/rankings";
import { Trophy } from "lucide-react";
import { cn } from "@/lib/utils";

interface RankingsLeaderboardProps {
  scores: StockScore[];
}

export function RankingsLeaderboard({ scores }: RankingsLeaderboardProps) {
  if (scores.length < 2) return null;

  return (
    <div className="bg-card border border-border rounded-xl p-6 shadow-sm">
      <div className="flex items-center gap-2 mb-6">
        <Trophy className="w-5 h-5 text-primary" />
        <h2 className="text-lg font-bold tracking-tight">Rankings Leaderboard</h2>
      </div>
      
      <div className="flex flex-col gap-4">
        {scores.map((score, idx) => {
          const isGold = idx === 0;
          const isSilver = idx === 1;
          const isBronze = idx === 2;

          return (
            <div 
              key={score.ticker}
              className={cn(
                "relative p-4 rounded-lg border flex items-center justify-between overflow-hidden",
                isGold ? "border-yellow-500/50 bg-yellow-500/10" :
                isSilver ? "border-slate-400/50 bg-slate-400/10" :
                isBronze ? "border-amber-700/50 bg-amber-700/10" :
                "border-border bg-background/50"
              )}
            >
              <div className="flex items-center gap-4 z-10">
                <div className={cn(
                  "w-8 h-8 rounded-full flex items-center justify-center font-bold text-sm",
                  isGold ? "bg-yellow-500 text-yellow-950" :
                  isSilver ? "bg-slate-400 text-slate-950" :
                  isBronze ? "bg-amber-700 text-amber-50" :
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
                </div>
              </div>

              <div className="text-right z-10 flex flex-col items-end">
                <div className="font-bold text-lg leading-none mb-1">
                  {score.totalScore.toFixed(2)} pts
                </div>
                <div className="w-24 h-1.5 bg-background rounded-full overflow-hidden">
                  <div 
                    className={cn(
                      "h-full rounded-full",
                      isGold ? "bg-yellow-500" :
                      isSilver ? "bg-slate-400" :
                      isBronze ? "bg-amber-700" :
                      "bg-primary"
                    )}
                    style={{ width: `${(score.totalScore / scores[0].totalScore) * 100}%` }}
                  />
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
