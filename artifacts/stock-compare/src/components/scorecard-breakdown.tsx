import { StockScore, SCORECARD_METRICS } from "@/lib/rankings";
import { formatNumber, formatPercent } from "@/lib/format";
import { cn } from "@/lib/utils";

interface ScorecardBreakdownProps {
  scores: StockScore[];
}

export function ScorecardBreakdown({ scores }: ScorecardBreakdownProps) {
  if (scores.length < 2) return null;

  return (
    <div className="bg-card border border-border rounded-xl overflow-hidden shadow-sm">
      <div className="px-6 py-4 border-b border-border bg-secondary/30">
        <h3 className="font-bold tracking-tight">Metric Breakdown & Rank</h3>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-left border-collapse min-w-max">
          <thead>
            <tr className="border-b border-border bg-secondary/10">
              <th className="p-4 font-semibold text-muted-foreground text-xs uppercase tracking-wider sticky left-0 bg-secondary/10 w-48">Factor</th>
              <th className="p-4 font-semibold text-muted-foreground text-xs uppercase tracking-wider text-center w-24">Weight</th>
              {scores.map((score) => (
                <th key={score.ticker} className="p-4 font-semibold text-muted-foreground text-xs uppercase tracking-wider text-right">
                  {score.ticker}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {SCORECARD_METRICS.map((metric) => (
              <tr key={metric.key} className="border-b border-border/50 hover:bg-secondary/20 transition-colors">
                <td className="p-4 align-top sticky left-0 bg-card">
                  <div className="font-medium">{metric.label}</div>
                  <div className="text-xs text-muted-foreground">
                    {metric.higherIsBetter ? "Higher is better" : "Lower is better"}
                  </div>
                </td>
                <td className="p-4 align-top text-center text-sm font-mono text-muted-foreground">
                  {metric.weight}x
                </td>
                {scores.map((score) => {
                  const ms = score.metricScores[metric.key];
                  const val = ms?.value;
                  const isPercent = ["revgrow", "epsgrow", "netmgn", "roe", "grossmgn", "upside"].includes(metric.key);
                  const displayVal = val == null ? "-" : (isPercent ? formatPercent(val) : formatNumber(val));
                  
                  return (
                    <td key={score.ticker} className="p-4 align-top text-right">
                      <div className="font-mono text-sm mb-1">{displayVal}</div>
                      <div className="inline-flex items-center justify-center px-1.5 py-0.5 rounded text-[10px] font-bold bg-secondary text-secondary-foreground min-w-[32px]">
                        #{ms?.rank || "-"}
                      </div>
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
