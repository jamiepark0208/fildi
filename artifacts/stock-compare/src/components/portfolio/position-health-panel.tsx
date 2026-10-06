// Detail sub-tab "Position Health": break-even, moneyness and assignment/exercise risk per option leg.
import { CardContent } from "@/components/ui/card";
import { daysToExpiry } from "@/hooks/use-portfolio";
import { formatCurrency } from "@/lib/format";
import { cn } from "@/lib/utils";
import { TTH, TTD, formatStrike } from "./portfolio-palette";
import type { OptionRow } from "./portfolio-risk-calc";

export function PositionHealthPanel({ putPositions, callPositions, liveDeltaById }: {
  putPositions: OptionRow[];
  callPositions: OptionRow[];
  /** Live Black-Scholes delta per portfolio entry id. */
  liveDeltaById: Map<string, number>;
}) {
  if (putPositions.length === 0 && callPositions.length === 0) {
    return (
      <CardContent className="px-4 pb-4">
        <div className="h-[60px] flex items-center justify-center text-xs text-muted-foreground">No open option positions</div>
      </CardContent>
    );
  }
  return (
    <CardContent className="px-4 pb-4 space-y-4">
      {[
        { label: "Puts", rows: putPositions, isPut: true },
        { label: "Calls", rows: callPositions, isPut: false },
      ].filter(g => g.rows.length > 0).map(({ label, rows, isPut }) => (
        <div key={label}>
          <div className="text-[10px] font-semibold text-muted-foreground uppercase tracking-widest mb-1.5 flex items-center gap-1.5">
            <span className={cn("w-1.5 h-1.5 rounded-full", isPut ? "bg-yellow-400" : "bg-blue-400")} />
            {label}
          </div>
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="border-y border-[#d4af37]/15 bg-secondary/20">
                  {["Ticker", "Type", "Qty", "Strike", "Premium", "Break-Even", "Current", isPut ? "OTM %" : "ITM %", "Collateral", "Status", "Delta", "Action"].map((h, hi) => (
                    <th key={h} className={cn(TTH, hi === 0 || hi === 1 ? "text-left" : "text-right")}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map((p, i) => {
                  const isShort = p.positionType === "short_put" || p.positionType === "short_call";
                  // For short puts: positive moneyness = OTM = safe; negative = ITM = at risk
                  // For short calls: negative moneyness = OTM = safe; positive = ITM = at risk
                  const mness = p.moneyness;
                  let safe = false, warn = false, atRisk = false;
                  if (isShort && isPut) {
                    safe   = mness !== null && mness >= 8;
                    warn   = mness !== null && mness >= 0 && mness < 8;
                    atRisk = mness !== null && mness < 0;
                  } else if (isShort && !isPut) {
                    safe   = mness !== null && mness <= -8;
                    warn   = mness !== null && mness > -8 && mness <= 0;
                    atRisk = mness !== null && mness > 0;
                  } else {
                    // long options: just show ITM/OTM
                    safe   = isPut ? (mness !== null && mness < 0) : (mness !== null && mness > 0);
                  }
                  const displayMness = isPut ? mness : (mness !== null ? -mness : null);
                  // Assignment-risk alert: delta is the standard risk measure
                  // (vs. raw moneyness above) — live, via Black-Scholes off
                  // live IV/spot (same endpoint the liquidity-risk card uses).
                  // Verified 2026-10-03 against this account's own 1,347 past
                  // trades. Threshold tuned 2026-10-04: a moneyness-band sweep
                  // (Vol Backtest tab) found 2% separates outcomes better than
                  // the 3% originally guessed, so the delta bar moved from 0.70
                  // to 0.75 in the same direction (tighter = cleaner signal) —
                  // the two scales aren't identical, so this is a directionally-
                  // informed adjustment, not an exact derived value.
                  const ASSIGNMENT_RISK_DELTA = 0.75;
                  const liveDelta = liveDeltaById.get(p.id);
                  const dte = daysToExpiry(p.expiry);
                  const highDelta = isShort && liveDelta != null && Math.abs(liveDelta) > ASSIGNMENT_RISK_DELTA;
                  const action: "roll" | "assign" | null = !highDelta ? null
                    : (dte != null && dte > 14) ? "roll" : "assign";
                  return (
                    <tr key={i} className={cn("border-b border-border/20 hover:bg-secondary/10 transition-colors", i % 2 === 0 ? "" : "bg-secondary/5")}>
                      <td className={cn(TTD, "text-left font-bold")}>{p.ticker}</td>
                      <td className={cn(TTD, "text-left")}>
                        <span className={cn("text-[10px] font-semibold px-1.5 py-0.5 rounded",
                          isShort ? "bg-green-500/15 text-green-400" : "bg-blue-500/15 text-blue-400")}>
                          {isShort ? "Short" : "Long"}
                        </span>
                      </td>
                      <td className={cn(TTD, "text-right text-muted-foreground")}>{p.qty}</td>
                      <td className={cn(TTD, "text-right")}>{formatStrike(p.strike)}</td>
                      <td className={cn(TTD, "text-right text-green-400")}>{isShort ? "+" : "−"}${p.premium.toFixed(2)}</td>
                      <td className={cn(TTD, "text-right")}>${p.breakEven.toFixed(2)}</td>
                      <td className={cn(TTD, "text-right")}>
                        {p.currentPrice !== null ? `$${p.currentPrice.toFixed(2)}` : <span className="text-muted-foreground">—</span>}
                      </td>
                      <td className={cn(TTD, "text-right font-semibold",
                        safe ? "text-green-400" : warn ? "text-yellow-400" : atRisk ? "text-red-400" : "text-muted-foreground")}>
                        {displayMness !== null ? `${displayMness > 0 ? "+" : ""}${displayMness.toFixed(1)}%` : "—"}
                      </td>
                      <td className={cn(TTD, "text-right", p.collateral !== null ? "text-yellow-400 font-semibold" : "text-muted-foreground")}>
                        {p.collateral !== null ? formatCurrency(p.collateral) : "—"}
                      </td>
                      <td className={cn(TTD, "text-right")}>
                        {isShort ? (
                          <span className={cn("px-1.5 py-0.5 rounded text-[10px] font-semibold",
                            safe   ? "bg-green-500/15 text-green-400" :
                            warn   ? "bg-yellow-500/15 text-yellow-400" :
                            atRisk ? "bg-red-500/15 text-red-400" :
                            "bg-secondary text-muted-foreground")}>
                            {safe ? "Safe" : warn ? "Watch" : atRisk ? "At Risk" : "—"}
                          </span>
                        ) : (
                          <span className={cn("px-1.5 py-0.5 rounded text-[10px] font-semibold",
                            safe ? "bg-blue-500/15 text-blue-400" : "bg-secondary text-muted-foreground")}>
                            {safe ? "ITM" : "OTM"}
                          </span>
                        )}
                      </td>
                      <td className={cn(TTD, "text-right", liveDelta != null && Math.abs(liveDelta) > ASSIGNMENT_RISK_DELTA ? "text-orange-400 font-semibold" : "text-muted-foreground")}>
                        {liveDelta != null ? liveDelta.toFixed(2) : "—"}
                      </td>
                      <td className={cn(TTD, "text-right")}>
                        {action === "assign" ? (
                          <span className="px-1.5 py-0.5 rounded text-[10px] font-semibold bg-red-500/15 text-red-400" title={`Delta > ${ASSIGNMENT_RISK_DELTA} with ≤14 DTE — little time left to roll`}>
                            Assignment Risk
                          </span>
                        ) : action === "roll" ? (
                          <span className="px-1.5 py-0.5 rounded text-[10px] font-semibold bg-orange-500/15 text-orange-400" title={`Delta > ${ASSIGNMENT_RISK_DELTA} with >14 DTE — consider rolling for credit`}>
                            Consider Roll
                          </span>
                        ) : (
                          <span className="text-muted-foreground">—</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      ))}
      <p className="text-[10px] text-muted-foreground/50">
        Puts OTM% = (price/strike−1)×100 · Calls ITM% = (price/strike−1)×100 · At Risk: short within 8% of strike
      </p>
    </CardContent>
  );
}
