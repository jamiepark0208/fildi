import { useState } from "react";
import { ChevronDown, ChevronUp } from "lucide-react";
import { PieChart, Pie, Cell } from "recharts";
import { cn } from "@/lib/utils";

export interface Recommendations {
  strongBuy: number;
  buy: number;
  hold: number;
  sell: number;
  strongSell: number;
}

export interface AnalystAction {
  firm: string;
  toGrade: string;
  fromGrade: string;
  action: string;
  date: string | null;
}

export interface AnalystPriceTarget {
  firm: string;
  analyst: string | null;
  priceTarget: number | null;
  date: string | null;
  priceWhenPosted: number | null;
  newsTitle: string | null;
}

export interface PriceTargetRange {
  high: number | null;
  low: number | null;
  mean: number | null;
  median: number | null;
}

function classifyGrade(toGrade: string): "bull" | "bear" | "neutral" {
  const grade = toGrade.toLowerCase();
  if (["buy", "strong buy", "outperform", "overweight", "positive"].some(g => grade.includes(g))) return "bull";
  if (["sell", "strong sell", "underperform", "underweight", "negative"].some(g => grade.includes(g))) return "bear";
  return "neutral";
}

const GRADE_COLOR_CLASS: Record<"bull" | "bear" | "neutral", string> = {
  bull: "text-green-400",
  bear: "text-red-400",
  neutral: "text-yellow-400",
};

function actionBullets(action: AnalystAction): string[] {
  const sentiment = classifyGrade(action.toGrade);
  if (sentiment === "bull") {
    if (action.action === "up") return ["Raised from prior rating — improved fundamental or near-term outlook", "May reflect accelerating earnings, margin expansion, or valuation re-rating catalyst"];
    if (action.action === "init") return ["Initiated coverage with constructive thesis on growth and/or valuation", "Entry point suggests risk/reward favors upside at current price"];
    return ["Reaffirming confidence in current trajectory — no material thesis change", "Sees continued upside relative to peers"];
  }
  if (sentiment === "bear") {
    if (action.action === "down") return ["Downgraded — deteriorating fundamentals, guidance cut, or valuation concern", "Risk/reward seen as unfavorable relative to sector peers"];
    if (action.action === "init") return ["Initiated with cautious stance — elevated valuation or competitive headwinds", "Sees limited upside versus downside risk at current price"];
    return ["Maintains cautious view — not yet seeing catalysts to turn constructive", "Monitoring for signs of stabilization before upgrading"];
  }
  return ["Neutral stance — balancing growth potential against valuation or execution risk", "Watching for clearer directional signal before committing to Buy or Sell"];
}

export function AnalystDonut({ recs }: { recs: Recommendations }) {
  const data = [
    { name: "Strong Buy", value: recs.strongBuy, color: "#22c55e" },
    { name: "Buy", value: recs.buy, color: "#4ade80" },
    { name: "Hold", value: recs.hold, color: "#facc15" },
    { name: "Sell", value: recs.sell, color: "#f97316" },
    { name: "Strong Sell", value: recs.strongSell, color: "#ef4444" },
  ].filter((d) => d.value > 0);

  const total = data.reduce((s, d) => s + d.value, 0);
  if (total === 0) return <p className="text-xs text-muted-foreground">No analyst data</p>;

  const bullishPct = ((recs.strongBuy + recs.buy) / total) * 100;
  const rating =
    bullishPct > 65
      ? "Buy"
      : bullishPct > 45
        ? "Outperform"
        : recs.hold / total > 0.5
          ? "Hold"
          : "Underperform";
  const ratingColor =
    rating === "Buy"
      ? "text-green-400"
      : rating === "Outperform"
        ? "text-green-300"
        : rating === "Hold"
          ? "text-yellow-400"
          : "text-orange-400";

  return (
    <div className="flex items-center gap-5">
      <div className="relative shrink-0">
        <PieChart width={96} height={96}>
          <Pie
            data={data}
            dataKey="value"
            cx={48}
            cy={48}
            innerRadius={30}
            outerRadius={44}
            strokeWidth={0}
          >
            {data.map((entry, i) => (
              <Cell key={i} fill={entry.color} />
            ))}
          </Pie>
        </PieChart>
        <div className="absolute inset-0 flex items-center justify-center">
          <span className={cn("text-[10px] font-bold", ratingColor)}>{rating}</span>
        </div>
      </div>
      <div className="space-y-1">
        {data.map((d) => (
          <div key={d.name} className="flex items-center gap-2 text-[11px]">
            <div className="w-2 h-2 rounded-sm shrink-0" style={{ backgroundColor: d.color }} />
            <span className="text-foreground">{d.name}</span>
            <span className="font-mono ml-auto pl-3 font-semibold text-foreground">{d.value}</span>
          </div>
        ))}
        <div className="pt-0.5 text-[11px] text-foreground border-t border-border/30">
          {total} analyst{total !== 1 ? "s" : ""}
        </div>
      </div>
    </div>
  );
}

export function AnalystRatingsSection({
  recs, metrics, analystActions, analystPriceTargets, priceTargetRange,
}: {
  recs: Recommendations;
  metrics: any;
  analystActions: AnalystAction[];
  analystPriceTargets: AnalystPriceTarget[];
  priceTargetRange: PriceTargetRange | null;
}) {
  const [expanded, setExpanded] = useState(false);
  const m = metrics;

  const pt = priceTargetRange;
  const hasRange = pt && pt.low != null && pt.high != null && m.currentPrice != null;
  const pricePct = hasRange
    ? Math.max(2, Math.min(98, ((m.currentPrice - pt.low!) / (pt.high! - pt.low!)) * 100))
    : null;
  const meanPct = hasRange && pt.mean != null
    ? Math.max(2, Math.min(98, ((pt.mean - pt.low!) / (pt.high! - pt.low!)) * 100))
    : null;

  return (
    <div className="bg-card border border-border/50 rounded-xl p-4">
      <button
        type="button"
        onClick={() => setExpanded(e => !e)}
        className="w-full flex items-center justify-between mb-4 group"
      >
        <span className="text-base font-bold tracking-tight text-foreground">Analyst Ratings</span>
        <span className="text-foreground group-hover:text-foreground transition-colors">
          {expanded ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
        </span>
      </button>

      {/* Always-visible: donut + consensus target */}
      <div className="flex flex-col sm:flex-row items-start sm:items-center gap-6">
        <AnalystDonut recs={recs} />
        {m.analystTargetPrice != null && m.currentPrice != null && (
          <div className="flex-1 border-t sm:border-t-0 sm:border-l border-border/40 pt-4 sm:pt-0 sm:pl-6">
            <div className="text-[10px] text-foreground uppercase tracking-widest mb-3">Consensus Price Target</div>
            <div className="flex items-end gap-3">
              <div>
                <div className="text-[10px] text-foreground mb-1">Current</div>
                <div className="text-xl font-bold font-mono">${m.currentPrice.toFixed(2)}</div>
              </div>
              <div className="text-foreground text-lg mb-1">→</div>
              <div>
                <div className="text-[10px] text-foreground mb-1">12M Target</div>
                <div className="text-xl font-bold font-mono">${m.analystTargetPrice.toFixed(2)}</div>
              </div>
              <div className={cn("text-base font-bold font-mono mb-0.5",
                m.analystTargetPrice > m.currentPrice ? "text-green-400" : "text-red-400")}>
                {((m.analystTargetPrice / m.currentPrice - 1) * 100) >= 0 ? "+" : ""}
                {((m.analystTargetPrice / m.currentPrice - 1) * 100).toFixed(1)}%
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Expanded: price target range + per-firm price targets */}
      {expanded && (
        <div className="mt-5 space-y-5 border-t border-border/30 pt-5">
          {/* Price target range bar */}
          {hasRange && (
            <div>
              <div className="text-[10px] text-foreground uppercase tracking-widest mb-2">Analyst Price Target Range</div>
              <div className="relative h-2.5 bg-secondary/50 rounded-full overflow-visible mb-3">
                <div className="absolute inset-0 rounded-full bg-gradient-to-r from-red-500/20 via-yellow-500/15 to-green-500/20" />
                {meanPct != null && (
                  <div
                    className="absolute top-1/2 -translate-y-1/2 -translate-x-1/2 w-2 h-4 bg-yellow-400/80 rounded-sm"
                    style={{ left: `${meanPct}%` }}
                    title={`Mean $${pt!.mean!.toFixed(2)}`}
                  />
                )}
                {pricePct != null && (
                  <div
                    className="absolute top-1/2 -translate-y-1/2 -translate-x-1/2 w-3 h-3 bg-primary rounded-full border-2 border-background shadow-sm z-10"
                    style={{ left: `${pricePct}%` }}
                    title={`Current $${m.currentPrice.toFixed(2)}`}
                  />
                )}
              </div>
              <div className="flex justify-between text-[10px] font-mono text-foreground">
                <span>Low ${pt!.low!.toFixed(2)}</span>
                {pt!.mean != null && <span className="text-yellow-400/90">Mean ${pt!.mean!.toFixed(2)}</span>}
                {pt!.median != null && <span>Median ${pt!.median!.toFixed(2)}</span>}
                <span>High ${pt!.high!.toFixed(2)}</span>
              </div>
            </div>
          )}

          {/* Recent analyst rating changes (upgrade/downgrade history) */}
          {analystActions.length > 0 && (
            <div>
              <div className="text-[10px] text-foreground uppercase tracking-widest mb-2">
                Analyst Rating Changes
              </div>
              <table className="w-full border-collapse">
                <thead>
                  <tr className="border-b border-border/40">
                    <th className="text-left font-normal text-[10px] text-foreground uppercase tracking-widest pb-1.5 pr-2">Entity</th>
                    <th className="text-left font-normal text-[10px] text-foreground uppercase tracking-widest pb-1.5 pr-2">Recommendation</th>
                    <th className="text-left font-normal text-[10px] text-foreground uppercase tracking-widest pb-1.5 pr-2">Notes</th>
                    <th className="text-right font-normal text-[10px] text-foreground uppercase tracking-widest pb-1.5">Last Updated</th>
                  </tr>
                </thead>
                <tbody>
                  {analystActions.map((a, i) => {
                    const color = GRADE_COLOR_CLASS[classifyGrade(a.toGrade)];
                    const gradeLabel = a.fromGrade && a.toGrade && a.fromGrade !== a.toGrade
                      ? `${a.fromGrade} → ${a.toGrade}`
                      : (a.toGrade || "—");
                    return (
                      <tr key={i} className="border-b border-border/20 last:border-0">
                        <td className="py-1.5 pr-2 text-xs font-medium text-foreground whitespace-nowrap">{a.firm}</td>
                        <td className={cn("py-1.5 pr-2 text-xs font-bold whitespace-nowrap", color)}>{gradeLabel}</td>
                        <td className="py-1.5 pr-2 text-[13px] text-foreground leading-snug">{actionBullets(a)[0]}</td>
                        <td className="py-1.5 text-xs text-foreground text-right whitespace-nowrap">{a.date ?? "—"}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}

          {/* Per-firm price targets from FMP */}
          {analystPriceTargets.length > 0 ? (
            <div>
              <div className="text-[10px] text-foreground uppercase tracking-widest mb-2">
                Price Targets by Firm
              </div>
              <div className="space-y-2">
                {analystPriceTargets.map((t, i) => {
                  const upside = t.priceTarget != null && m.currentPrice != null
                    ? ((t.priceTarget / m.currentPrice) - 1) * 100
                    : null;
                  const fromPosted = t.priceTarget != null && t.priceWhenPosted != null && t.priceWhenPosted > 0
                    ? ((t.priceTarget / t.priceWhenPosted) - 1) * 100
                    : null;
                  return (
                    <div key={i} className="border border-border/40 rounded-lg p-3 bg-secondary/10">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="text-sm font-bold text-foreground">{t.firm}</span>
                        {t.analyst && <span className="text-[11px] text-foreground">({t.analyst})</span>}
                        {t.priceTarget != null && (
                          <span className="ml-auto font-mono font-bold text-sm text-foreground">
                            ${t.priceTarget.toFixed(2)}
                          </span>
                        )}
                        {upside != null && (
                          <span className={cn("text-xs font-mono font-semibold", upside >= 0 ? "text-green-400" : "text-red-400")}>
                            {upside >= 0 ? "+" : ""}{upside.toFixed(1)}%
                          </span>
                        )}
                      </div>
                      {t.date && (
                        <div className="text-[10px] text-foreground mt-1">
                          Published {t.date}
                          {t.priceWhenPosted != null && ` · Stock was $${t.priceWhenPosted.toFixed(2)} at time of rating`}
                          {fromPosted != null && (
                            <span className={cn("ml-1", fromPosted >= 0 ? "text-green-400/80" : "text-red-400/80")}>
                              (implied {fromPosted >= 0 ? "+" : ""}{fromPosted.toFixed(0)}% from then)
                            </span>
                          )}
                        </div>
                      )}
                      {t.newsTitle && (
                        <p className="text-[11px] text-foreground mt-1.5 italic leading-snug line-clamp-2">
                          "{t.newsTitle}"
                        </p>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          ) : (
            <p className="text-sm text-foreground italic">Per-analyst price targets not available on current data plan.</p>
          )}
        </div>
      )}
    </div>
  );
}
