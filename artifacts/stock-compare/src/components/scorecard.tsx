import { Scorecard as ScorecardType, StockMetrics } from "@workspace/api-client-react";
import { formatPercent, formatNumber } from "@/lib/format";
import { Trophy, AlertTriangle, Info } from "lucide-react";
import { cn } from "@/lib/utils";

interface ScorecardProps {
  scorecard: ScorecardType;
  stock1: StockMetrics;
  stock2: StockMetrics;
}

export function Scorecard({ scorecard, stock1, stock2 }: ScorecardProps) {
  const s1Winner = scorecard.winner === stock1.ticker;
  const s2Winner = scorecard.winner === stock2.ticker;

  return (
    <div className="space-y-8">
      {/* Verdict Header */}
      <div className="bg-card border border-border rounded-xl overflow-hidden relative">
        <div className="absolute top-0 left-0 w-full h-1 bg-gradient-to-r from-primary to-accent"></div>
        <div className="p-8 md:p-12 text-center flex flex-col items-center">
          <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-primary/10 text-primary text-sm font-bold mb-6">
            <Trophy className="w-4 h-4" />
            VERDICT
          </div>
          
          <div className="flex items-center justify-center gap-8 mb-8">
            <div className={cn("text-center transition-all", s1Winner ? "scale-110" : "opacity-50 grayscale")}>
              <div className="text-5xl font-mono font-black mb-2 text-foreground tracking-tighter">{stock1.ticker}</div>
              <div className="text-xl font-bold text-primary">{scorecard.ticker1TotalScore} PTS</div>
            </div>
            
            <div className="text-muted-foreground text-2xl font-light italic">vs</div>
            
            <div className={cn("text-center transition-all", s2Winner ? "scale-110" : "opacity-50 grayscale")}>
              <div className="text-5xl font-mono font-black mb-2 text-foreground tracking-tighter">{stock2.ticker}</div>
              <div className="text-xl font-bold text-primary">{scorecard.ticker2TotalScore} PTS</div>
            </div>
          </div>

          <p className="text-2xl font-medium max-w-3xl leading-relaxed">
            {scorecard.summary}
          </p>
          
          <div className="mt-8 flex items-center gap-4">
            <div className="px-4 py-2 rounded bg-secondary text-secondary-foreground text-sm font-medium flex items-center gap-2">
              <AlertTriangle className="w-4 h-4" />
              Confidence: <span className="font-bold text-primary">{scorecard.confidence}</span>
            </div>
          </div>
        </div>
      </div>

      {/* Breakdown Table */}
      <div className="bg-card border border-border rounded-xl overflow-hidden">
        <div className="px-6 py-4 border-b border-border bg-secondary/30">
          <h3 className="font-bold tracking-tight">Metric Breakdown</h3>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse">
            <thead>
              <tr className="border-b border-border bg-secondary/10">
                <th className="p-4 font-semibold text-muted-foreground text-xs uppercase tracking-wider">Factor</th>
                <th className="p-4 font-semibold text-muted-foreground text-xs uppercase tracking-wider text-right">{stock1.ticker}</th>
                <th className="p-4 font-semibold text-muted-foreground text-xs uppercase tracking-wider text-right">{stock2.ticker}</th>
                <th className="p-4 font-semibold text-muted-foreground text-xs uppercase tracking-wider">Advantage</th>
              </tr>
            </thead>
            <tbody>
              {scorecard.items.map((item, idx) => (
                <tr key={idx} className="border-b border-border/50 hover:bg-secondary/20 transition-colors">
                  <td className="p-4 align-top">
                    <div className="font-medium mb-1">{item.metric}</div>
                    <div className="text-sm text-muted-foreground max-w-xs">{item.explanation}</div>
                  </td>
                  <td className={cn(
                    "p-4 align-top text-right font-mono",
                    item.winner === stock1.ticker ? "text-primary font-bold" : "text-muted-foreground"
                  )}>
                    {item.ticker1Value || "-"}
                  </td>
                  <td className={cn(
                    "p-4 align-top text-right font-mono",
                    item.winner === stock2.ticker ? "text-primary font-bold" : "text-muted-foreground"
                  )}>
                    {item.ticker2Value || "-"}
                  </td>
                  <td className="p-4 align-top">
                    {item.winner ? (
                      <span className="inline-flex items-center px-2 py-1 rounded bg-primary/10 text-primary text-xs font-bold font-mono">
                        {item.winner}
                      </span>
                    ) : (
                      <span className="inline-flex items-center px-2 py-1 rounded bg-secondary text-muted-foreground text-xs font-medium">
                        TIE
                      </span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
