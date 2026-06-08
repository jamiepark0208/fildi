import { Sidebar } from "@/components/sidebar";
import { SCORECARD_METRICS_V2 } from "@/lib/rankings";
import { TECHNICAL_SCORECARD_METRICS } from "@/lib/technical-rankings";
import { BookOpen, TrendingDown, TrendingUp, Info } from "lucide-react";

type MetricRow = { key: string; label: string; higherIsBetter: boolean; weight?: number; intraWeight?: number };
function metricWeight(m: MetricRow) { return m.intraWeight ?? m.weight ?? 0; }

function MetricTable({ metrics }: { metrics: MetricRow[] }) {
  const maxWeight = Math.max(...metrics.map(metricWeight));
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm border-collapse">
        <thead>
          <tr className="border-b border-border">
            <th className="p-3 text-left font-semibold text-muted-foreground">Metric</th>
            <th className="p-3 text-center font-semibold text-muted-foreground w-24">Weight</th>
            <th className="p-3 text-left font-semibold text-muted-foreground">Better when</th>
          </tr>
        </thead>
        <tbody>
          {metrics.map(m => (
            <tr key={m.key} className="border-b border-border/40 hover:bg-secondary/10">
              <td className="p-3 font-medium">{m.label}</td>
              <td className="p-3 text-center">
                <div className="flex items-center justify-center gap-2">
                  <span className="font-mono font-bold text-primary">{metricWeight(m).toFixed(1)}</span>
                  <div className="w-16 h-1.5 bg-secondary rounded-full overflow-hidden">
                    <div
                      className="h-full bg-primary/60 rounded-full"
                      style={{ width: `${(metricWeight(m) / maxWeight) * 100}%` }}
                    />
                  </div>
                </div>
              </td>
              <td className="p-3">
                {m.higherIsBetter ? (
                  <span className="flex items-center gap-1 text-green-400 text-xs font-medium">
                    <TrendingUp className="w-3 h-3" /> Higher
                  </span>
                ) : (
                  <span className="flex items-center gap-1 text-blue-400 text-xs font-medium">
                    <TrendingDown className="w-3 h-3" /> Lower
                  </span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr className="bg-secondary/30">
            <td className="p-3 font-bold">Max Possible Score</td>
            <td className="p-3 text-center font-mono font-bold text-primary">
              {metrics.reduce((s, m) => s + metricWeight(m), 0).toFixed(1)}
            </td>
            <td />
          </tr>
        </tfoot>
      </table>
    </div>
  );
}

export default function ScorecardExplanation() {
  return (
    <div className="min-h-[100dvh] bg-background text-foreground selection:bg-primary/30 flex">
      <Sidebar />

      <main className="flex-1 ml-[220px] min-w-0">
        <div className="p-5 border-b border-border/50 sticky top-0 bg-background/95 backdrop-blur z-40">
          <div className="flex items-center gap-2">
            <BookOpen className="w-5 h-5 text-primary" />
            <div>
              <h1 className="text-lg font-bold tracking-tight leading-none">Scorecard Guide</h1>
              <p className="text-xs text-muted-foreground mt-0.5">How fundamental and technical scores are calculated</p>
            </div>
          </div>
        </div>

        <div className="p-5 space-y-6 max-w-4xl">

          {/* Scoring methodology overview */}
          <div className="bg-card border border-border rounded-xl p-5 shadow-sm space-y-3">
            <div className="flex items-center gap-2">
              <Info className="w-4 h-4 text-primary" />
              <h2 className="font-bold text-base">How Scoring Works</h2>
            </div>
            <div className="space-y-2 text-sm text-muted-foreground leading-relaxed">
              <p>
                Scores are <strong className="text-foreground">relative</strong>, not absolute. Every metric is ranked
                across the tickers you have loaded. The best-performing stock on each metric gets a score of&nbsp;
                <span className="font-mono text-primary">1.0</span>, the worst gets&nbsp;
                <span className="font-mono text-primary">0.0</span>, and the rest are interpolated linearly in between.
              </p>
              <p>
                Each metric's rank-score is multiplied by its <strong className="text-foreground">weight</strong>.
                The total score is the sum of all weighted metric scores. A stock that tops every single metric would
                reach the <strong className="text-foreground">max possible score</strong> shown at the bottom of each
                table — but in practice no stock wins every metric.
              </p>
              <p>
                Adding or removing tickers changes all scores — because each stock is only judged relative to its
                current peers. A score near 80 % of the max is strong in your comparison set.
              </p>
            </div>
          </div>

          {/* Fundamental */}
          <div className="bg-card border border-border rounded-xl overflow-hidden shadow-sm">
            <div className="p-5 border-b border-border">
              <h2 className="font-bold text-base">Fundamental Score</h2>
              <p className="text-xs text-muted-foreground mt-0.5">
                Used in the <strong>Fundamental Analysis</strong> tab · 13 metrics · max {SCORECARD_METRICS_V2.reduce((s, m) => s + metricWeight(m), 0).toFixed(1)} pts
              </p>
            </div>
            <MetricTable metrics={SCORECARD_METRICS_V2} />
            <div className="p-4 bg-secondary/10 border-t border-border space-y-1.5 text-xs text-muted-foreground">
              <p>
                <strong className="text-foreground">P/E Ratio:</strong> Negative P/E (company is losing money) is
                excluded from scoring — it neither helps nor penalises the stock on this metric. Other metrics still
                count normally.
              </p>
              <p>
                <strong className="text-foreground">Price / FCF:</strong> Only calculated when both Market Cap and
                positive Free Cash Flow are available. Negative FCF companies are excluded.
              </p>
              <p>
                <strong className="text-foreground">Analyst Upside:</strong> Derived from{" "}
                (Analyst Target Price ÷ Current Price) − 1. This is a proxy for fair value; it reflects consensus
                expectations, not intrinsic value calculations.
              </p>
              <p>
                <strong className="text-foreground">Missing data:</strong> If a stock has no value for a metric (e.g.
                no dividend yield), it scores 0 on that metric. Comparing stocks with different data availability can
                disadvantage the stock with the missing data.
              </p>
            </div>
          </div>

          {/* Technical */}
          <div className="bg-card border border-border rounded-xl overflow-hidden shadow-sm">
            <div className="p-5 border-b border-border">
              <h2 className="font-bold text-base">Technical Score</h2>
              <p className="text-xs text-muted-foreground mt-0.5">
                Used in the <strong>Technical Scorecard</strong> tab · 8 metrics · max {TECHNICAL_SCORECARD_METRICS.reduce((s, m) => s + m.weight, 0).toFixed(1)} pts
              </p>
            </div>
            <MetricTable metrics={TECHNICAL_SCORECARD_METRICS} />
            <div className="p-4 bg-secondary/10 border-t border-border space-y-1.5 text-xs text-muted-foreground">
              <p>
                <strong className="text-foreground">Purpose:</strong> The technical score ranks stocks by how
                attractive they are for the FILDI strategy — selling weekly OTM cash-secured puts on oversold stocks.
                Lower RSI, MFI, 52w position, and recent return all score better because they indicate the stock
                has pulled back and may be near a support level.
              </p>
              <p>
                <strong className="text-foreground">Signal:</strong> GO (both RSI &lt; threshold AND MFI &lt; 25) scores 2 points;
                WATCH (one condition met) scores 1; NO scores 0. Signal carries the highest weight (3.0) because
                it directly encodes the entry criteria.
              </p>
              <p>
                <strong className="text-foreground">MACD:</strong> Bullish Crossover → 3, Bullish → 2, Bearish → 1,
                Bearish Crossover → 0. When MACD is unavailable (not enough history), the metric is skipped.
              </p>
              <p>
                <strong className="text-foreground">RSI threshold:</strong> Each ticker has a per-tier threshold
                (e.g., T1 stocks use RSI &lt; 45, others may use different values). The RSI score is based on the
                raw RSI value, so a T1 stock at RSI 42 and a T3 stock at RSI 42 are treated equally by the scorer
                even though only the T1 stock has cleared its threshold.
              </p>
            </div>
          </div>

          {/* Rankings leaderboard */}
          <div className="bg-card border border-border rounded-xl p-5 shadow-sm space-y-3">
            <h2 className="font-bold text-base">Rankings Leaderboard</h2>
            <div className="space-y-2 text-sm text-muted-foreground leading-relaxed">
              <p>
                Both tabs show a <strong className="text-foreground">Rankings Leaderboard</strong> when 2 or more
                tickers are loaded. Each entry shows the stock's total score, a progress bar relative to the
                #1 stock, and a brief reason derived directly from the data — no AI or opinion involved.
              </p>
              <p>
                The <strong className="text-foreground">fundamental reason</strong> lists the top 2 metrics the stock
                leads in and the bottom 2 metrics it lags in (both based on normalized rank scores).
              </p>
              <p>
                The <strong className="text-foreground">technical reason</strong> states the signal condition
                (GO / WATCH / NO with RSI and MFI values), MACD crossover status if present, and 52-week position
                context if the stock is near an extreme.
              </p>
            </div>
          </div>

        </div>
      </main>
    </div>
  );
}
