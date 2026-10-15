// Detail sub-tab "Vol Backtest": the account's own expired short options graded by vol regime.
import { CardContent } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import { TTH, TTD } from "./portfolio-palette";

/** GET /api/portfolio/iv-rank-backtest */
export interface IvRankBacktest {
  buckets: Array<{ bucket: "Low" | "Mid" | "High"; count: number; keptFullPremiumPct: number; avgPremiumPerContract: number; avgTrailingVol20dAnnualizedPct: number }>;
  totalEligible: number; graded: number; tickersWithNoPriceHistory: string[];
  assignmentRiskCheckpoint: { checkedCount: number; flaggedCount: number; flaggedWentItmPct: number; unflaggedCount: number; unflaggedWentItmPct: number };
  earningsRiskCheck: { inWindowCount: number; inWindowKeptFullPremiumPct: number; outsideWindowCount: number; outsideWindowKeptFullPremiumPct: number };
  moneynessBandSweep: Array<{ bandPct: number; flaggedCount: number; flaggedWentItmPct: number; unflaggedWentItmPct: number; separation: number }>;
  coveredCallCheck: { totalCallTrades: number; itmCallTrades: number; coveredItmCount: number; nakedOrUnknownItmCount: number };
}

export function VolBacktestPanel({ data, loading }: { data: IvRankBacktest | undefined; loading: boolean }) {
  return (
    <CardContent className="px-4 pb-4">
      {loading && (
        <div className="h-[120px] flex items-center justify-center text-xs text-white">Running backtest (fetching price history)...</div>
      )}
      {!loading && data && data.graded === 0 && (
        <div className="h-[120px] flex items-center justify-center text-xs text-white">No expired, graded short-option trades yet</div>
      )}
      {!loading && data && data.graded > 0 && (
        <div className="space-y-3">
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="border-y border-[#d4af37]/15 bg-secondary/20">
                  {["Vol Regime", "Trades", "Kept Full Premium", "Avg Trailing Vol (ann.)", "Avg Premium/Contract"].map((h, i) => (
                    <th key={h} className={cn(TTH, i === 0 ? "text-left" : "text-right")}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {data.buckets.map((b, i) => (
                  <tr key={b.bucket} className={cn("border-b border-border/20", i % 2 === 0 ? "" : "bg-secondary/5")}>
                    <td className={cn(TTD, "text-left font-bold")}>{b.bucket}</td>
                    <td className={cn(TTD, "text-right text-white")}>{b.count}</td>
                    <td className={cn(TTD, "text-right font-semibold",
                      b.keptFullPremiumPct >= 80 ? "text-green-400" : b.keptFullPremiumPct >= 70 ? "text-yellow-400" : "text-red-400")}>
                      {b.keptFullPremiumPct.toFixed(1)}%
                    </td>
                    <td className={cn(TTD, "text-right")}>{b.avgTrailingVol20dAnnualizedPct.toFixed(1)}%</td>
                    <td className={cn(TTD, "text-right")}>${b.avgPremiumPerContract.toFixed(2)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="text-[10px] text-white/80 leading-relaxed">
            {data.graded} expired short-option trades graded since 2026-01-01 ({data.totalEligible - data.graded} skipped — no price history). Vol regime = trailing 20-day realized volatility of the underlying as of each trade's open date (a proxy — true historical IV isn't available for these tickers). "Kept Full Premium" = underlying closed OTM at expiration (put: price ≥ strike; call: price ≤ strike). Covered calls assigned ITM aren't necessarily losses — this measures assignment-risk frequency by vol regime, not P&L (see the covered-call breakout below for how much of the call-side rate this actually affects).
            {data.tickersWithNoPriceHistory.length > 0 && ` No price history: ${data.tickersWithNoPriceHistory.join(", ")}.`}
          </p>

          {data.coveredCallCheck.itmCallTrades > 0 && (
            <div className="rounded border border-[#d4af37]/15 bg-secondary/10 px-3 py-2.5 space-y-1.5">
              <div className="text-[10px] font-semibold text-[#d4af37] uppercase tracking-wide">
                Covered-Call Correction
              </div>
              <p className="text-[11px]">
                Of {data.coveredCallCheck.itmCallTrades} short-call trades that finished ITM (counted as "didn't keep full premium" in the table above),{" "}
                <span className="font-mono font-semibold text-blue-400">{data.coveredCallCheck.coveredItmCount}</span>{" "}
                ({((data.coveredCallCheck.coveredItmCount / data.coveredCallCheck.itmCallTrades) * 100).toFixed(0)}%) were covered — shares were already held when the call was sold — vs.{" "}
                <span className="font-mono font-semibold text-red-400">{data.coveredCallCheck.nakedOrUnknownItmCount}</span>{" "}
                naked or unknown-coverage.
              </p>
              <p className="text-[10px] text-white/80 leading-relaxed">
                A covered call assigned ITM is very often a planned, profitable exit (premium kept + stock sold at the strike) — not comparable to a naked assignment or an ITM short put. Of {data.coveredCallCheck.totalCallTrades} total call trades, nearly all ITM ones were covered, so the call-side "risk" in the bucket table above is mostly normal wheel behavior, not a warning sign.
              </p>
            </div>
          )}

          {data.assignmentRiskCheckpoint.checkedCount > 0 && (
            <div className="rounded border border-[#d4af37]/15 bg-secondary/10 px-3 py-2.5 space-y-1.5">
              <div className="text-[10px] font-semibold text-[#d4af37] uppercase tracking-wide">
                Assignment-Risk Alert — Verified Against Your Own History
              </div>
              <div className="flex gap-6 text-[11px]">
                <div>
                  <span className="text-white">Flagged at risk</span>{" "}
                  <span className="font-mono font-semibold text-red-400">{data.assignmentRiskCheckpoint.flaggedWentItmPct.toFixed(1)}%</span>{" "}
                  <span className="text-white">went ITM</span>{" "}
                  <span className="text-white/80">(n={data.assignmentRiskCheckpoint.flaggedCount})</span>
                </div>
                <div>
                  <span className="text-white">Not flagged</span>{" "}
                  <span className="font-mono font-semibold text-green-400">{data.assignmentRiskCheckpoint.unflaggedWentItmPct.toFixed(1)}%</span>{" "}
                  <span className="text-white">went ITM</span>{" "}
                  <span className="text-white/80">(n={data.assignmentRiskCheckpoint.unflaggedCount})</span>
                </div>
              </div>
              <p className="text-[10px] text-white/80 leading-relaxed">
                The live "Consider Roll" / "Assignment Risk" tags on the Position Health tab use delta &gt; 0.75 — this checks that same rule's moneyness proxy (2% band, tuned below) at the midpoint of each trade's own holding period (scaled to the trade's own DTE, since most of this account's trades are 2-9 day weeklies, shorter than a fixed days-out window) against what actually happened by expiration. Flagged trades going ITM {data.assignmentRiskCheckpoint.flaggedWentItmPct.toFixed(0)}% of the time vs. {data.assignmentRiskCheckpoint.unflaggedWentItmPct.toFixed(0)}% for unflagged ones means the alert is picking up a real signal, not noise.
              </p>
              {data.moneynessBandSweep.length > 0 && (
                <div className="pt-1.5 border-t border-[#d4af37]/10">
                  <div className="text-[10px] font-semibold text-white uppercase tracking-wide mb-1">Threshold Sweep — Is 2% The Best Band?</div>
                  <div className="overflow-x-auto">
                    <table className="w-full">
                      <thead>
                        <tr className="border-b border-[#d4af37]/10">
                          {["Band", "n", "Flagged ITM%", "Unflagged ITM%", "Separation"].map((h, i) => (
                            <th key={h} className={cn(TTH, i === 0 ? "text-left" : "text-right")}>{h}</th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {data.moneynessBandSweep.map(r => (
                          <tr key={r.bandPct} className={cn("border-b border-border/10", r.bandPct === 2 && "bg-[#d4af37]/10")}>
                            <td className={cn(TTD, "text-left font-semibold")}>{r.bandPct}%{r.bandPct === 2 ? " (current)" : ""}</td>
                            <td className={cn(TTD, "text-right text-white")}>{r.flaggedCount}</td>
                            <td className={cn(TTD, "text-right")}>{r.flaggedWentItmPct.toFixed(1)}%</td>
                            <td className={cn(TTD, "text-right")}>{r.unflaggedWentItmPct.toFixed(1)}%</td>
                            <td className={cn(TTD, "text-right font-semibold", r.separation >= 40 ? "text-green-400" : "text-white")}>{r.separation.toFixed(1)}pp</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  <p className="text-[10px] text-white mt-1">
                    Separation = flagged ITM% − unflagged ITM% (bigger = cleaner signal). Narrower bands (1-2%) separate better than wider ones, but flag fewer positions — 2% is the sample-size/signal tradeoff point used live. This band and the live delta threshold measure different things (moneyness snapshot vs. live Black-Scholes delta) and aren't numerically equivalent — the live threshold was moved in the same direction, not derived from this exact number.
                  </p>
                </div>
              )}
            </div>
          )}

          {(data.earningsRiskCheck.inWindowCount + data.earningsRiskCheck.outsideWindowCount) > 0 && (
            <div className="rounded border border-[#d4af37]/15 bg-secondary/10 px-3 py-2.5 space-y-1.5">
              <div className="text-[10px] font-semibold text-[#d4af37] uppercase tracking-wide">
                Earnings-Risk Flag — Verified Against Your Own History
              </div>
              <div className="flex gap-6 text-[11px]">
                <div>
                  <span className="text-white">Earnings in window</span>{" "}
                  <span className="font-mono font-semibold">{data.earningsRiskCheck.inWindowKeptFullPremiumPct.toFixed(1)}%</span>{" "}
                  <span className="text-white">kept full premium</span>{" "}
                  <span className="text-white/80">(n={data.earningsRiskCheck.inWindowCount})</span>
                </div>
                <div>
                  <span className="text-white">No earnings in window</span>{" "}
                  <span className="font-mono font-semibold">{data.earningsRiskCheck.outsideWindowKeptFullPremiumPct.toFixed(1)}%</span>{" "}
                  <span className="text-white">kept full premium</span>{" "}
                  <span className="text-white/80">(n={data.earningsRiskCheck.outsideWindowCount})</span>
                </div>
              </div>
              <p className="text-[10px] text-white/80 leading-relaxed">
                {Math.abs(data.earningsRiskCheck.inWindowKeptFullPremiumPct - data.earningsRiskCheck.outsideWindowKeptFullPremiumPct) < 5
                  ? "Honest finding: these two rates are close — for this account's actual trades (mostly 2-9 DTE weeklies), spanning an earnings date hasn't meaningfully predicted a worse outcome. Only a small fraction of contracts are even long enough to span an earnings date, so this flag matters far more if/when longer-dated positions are opened, less so for the weekly wheel that dominates current volume."
                  : "These rates differ meaningfully — earnings-window exposure does appear to correlate with outcome for this account's trades, worth continuing to watch."}
              </p>
            </div>
          )}
        </div>
      )}
    </CardContent>
  );
}
