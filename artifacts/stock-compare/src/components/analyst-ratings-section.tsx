import { Fragment, useMemo, useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import { PieChart, Pie, Cell } from "recharts";
import { cn } from "@/lib/utils";
import { formatMdYy } from "@/lib/format";

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
  priceTarget?: number | null;
  source?: "yahoo" | "fmp" | "headline";
}

export interface AnalystPriceTarget {
  firm: string;
  analyst: string | null;
  priceTarget: number | null;
  date: string | null;
  priceWhenPosted: number | null;
  newsTitle: string | null;
  source?: "fmp" | "headline";
}

const SOURCE_LABEL: Record<string, string> = {
  fmp: "FMP",
  headline: "News-derived",
};

function SourceBadge({ source }: { source?: string }) {
  if (!source || source === "yahoo") return null;
  const label = SOURCE_LABEL[source] ?? source;
  return (
    <span
      className={cn(
        "text-[9px] font-semibold uppercase tracking-wide px-1 py-0.5 rounded",
        source === "headline" ? "bg-yellow-500/15 text-yellow-400" : "bg-primary/15 text-primary",
      )}
      title={source === "headline" ? "Parsed from a news headline — lower confidence" : "Archived from FMP's analyst feed"}
    >
      {label}
    </span>
  );
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
    <div className="flex items-center gap-3">
      <div className="relative shrink-0">
        <PieChart width={72} height={72}>
          <Pie
            data={data}
            dataKey="value"
            cx={36}
            cy={36}
            innerRadius={22}
            outerRadius={33}
            strokeWidth={0}
          >
            {data.map((entry, i) => (
              <Cell key={i} fill={entry.color} />
            ))}
          </Pie>
        </PieChart>
        <div className="absolute inset-0 flex items-center justify-center">
          <span className={cn("text-[9px] font-bold", ratingColor)}>{rating}</span>
        </div>
      </div>
      <div className="space-y-0.5 min-w-0 flex-1">
        {data.map((d) => (
          <div key={d.name} className="flex items-center gap-1.5 text-[10px]">
            <div className="w-1.5 h-1.5 rounded-sm shrink-0" style={{ backgroundColor: d.color }} />
            <span className="text-foreground truncate">{d.name}</span>
            <span className="font-mono ml-auto pl-2 font-semibold text-foreground tabular-nums">{d.value}</span>
          </div>
        ))}
        <div className="pt-0.5 text-[10px] text-amber-200/50 border-t border-border/30">
          {total} analyst{total !== 1 ? "s" : ""}
        </div>
      </div>
    </div>
  );
}

function firmKey(firm: string): string {
  return firm.toLowerCase().replace(/\s+/g, " ").trim();
}

/** One row per firm (latest event); older events available via expand. */
function groupActionsByFirm(actions: AnalystAction[]): Array<{ firm: string; latest: AnalystAction; history: AnalystAction[] }> {
  const byFirm = new Map<string, AnalystAction[]>();
  for (const a of actions) {
    const k = firmKey(a.firm);
    const list = byFirm.get(k);
    if (list) list.push(a);
    else byFirm.set(k, [a]);
  }
  const groups = Array.from(byFirm.values()).map(list => {
    const sorted = [...list].sort((a, b) => (b.date ?? "").localeCompare(a.date ?? ""));
    return { firm: sorted[0]!.firm, latest: sorted[0]!, history: sorted.slice(1) };
  });
  groups.sort((a, b) => (b.latest.date ?? "").localeCompare(a.latest.date ?? ""));
  return groups;
}

function shortGrade(g: string): string {
  return g.replace(/\bequal[\s-]?weight\b/gi, "Equal");
}

function gradeLabel(a: AnalystAction): string {
  const from = a.fromGrade ? shortGrade(a.fromGrade) : "";
  const to = a.toGrade ? shortGrade(a.toGrade) : "";
  return from && to && from !== to ? `${from} → ${to}` : (to || "—");
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
  const m = metrics;
  const firmGroups = useMemo(() => groupActionsByFirm(analystActions), [analystActions]);
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const toggleFirm = (key: string) => {
    setExpanded(prev => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const pt = priceTargetRange;
  const hasRange = pt && pt.low != null && pt.high != null && m.currentPrice != null;
  const pricePct = hasRange
    ? Math.max(2, Math.min(98, ((m.currentPrice - pt.low!) / (pt.high! - pt.low!)) * 100))
    : null;
  const meanPct = hasRange && pt.mean != null
    ? Math.max(2, Math.min(98, ((pt.mean - pt.low!) / (pt.high! - pt.low!)) * 100))
    : null;

  const upsidePct =
    m.analystTargetPrice != null && m.currentPrice != null
      ? ((m.analystTargetPrice / m.currentPrice - 1) * 100)
      : null;

  return (
    <div className="space-y-2">
      <AnalystDonut recs={recs} />

      {/* Consensus + 12M target — single line under the donut */}
      {m.analystTargetPrice != null && m.currentPrice != null && (
        <div className="flex items-center gap-1.5 text-[11px] font-mono flex-wrap border-t border-border/30 pt-1.5">
          <span className="text-[9px] uppercase tracking-wider text-[#d4af37] font-sans font-bold">Consensus</span>
          <span className="tabular-nums text-white font-semibold">${m.currentPrice.toFixed(2)}</span>
          <span className="text-amber-200">→</span>
          <span className="text-[9px] uppercase tracking-wider text-[#d4af37] font-sans font-bold">12M</span>
          <span className="tabular-nums font-bold text-white">${m.analystTargetPrice.toFixed(2)}</span>
          {upsidePct != null && (
            <span
              className={cn(
                "tabular-nums font-bold ml-auto",
                upsidePct >= 0 ? "text-green-400" : "text-red-400",
              )}
            >
              {upsidePct >= 0 ? "+" : ""}
              {upsidePct.toFixed(1)}%
            </span>
          )}
        </div>
      )}

      <div className="space-y-2.5 border-t border-border/30 pt-2">
          {hasRange && (
            <div>
              <div className="text-[9px] text-[#d4af37] font-bold uppercase tracking-wider mb-1">Target range</div>
              <div className="relative h-2 bg-secondary/50 rounded-full overflow-visible mb-1.5">
                <div className="absolute inset-0 rounded-full bg-gradient-to-r from-red-500/20 via-yellow-500/15 to-green-500/20" />
                {meanPct != null && (
                  <div
                    className="absolute top-1/2 -translate-y-1/2 -translate-x-1/2 w-1.5 h-3 bg-yellow-400/80 rounded-sm"
                    style={{ left: `${meanPct}%` }}
                    title={`Mean $${pt!.mean!.toFixed(2)}`}
                  />
                )}
                {pricePct != null && (
                  <div
                    className="absolute top-1/2 -translate-y-1/2 -translate-x-1/2 w-2.5 h-2.5 bg-primary rounded-full border-2 border-background shadow-sm z-10"
                    style={{ left: `${pricePct}%` }}
                    title={`Current $${m.currentPrice.toFixed(2)}`}
                  />
                )}
              </div>
              <div className="flex justify-between text-[9px] font-mono text-amber-50 gap-1">
                <span>L ${pt!.low!.toFixed(2)}</span>
                {pt!.mean != null && <span className="text-yellow-300 font-semibold">μ ${pt!.mean!.toFixed(2)}</span>}
                {pt!.median != null && <span>M ${pt!.median!.toFixed(2)}</span>}
                <span>H ${pt!.high!.toFixed(2)}</span>
              </div>
            </div>
          )}

          {firmGroups.length > 0 && (
            <div>
              <div className="text-[9px] text-[#d4af37] font-bold uppercase tracking-wider mb-1">
                Rating changes
              </div>
              <table className="w-full border-collapse">
                <thead>
                  <tr className="border-b border-border/40">
                    <th className="text-left font-bold text-[9px] text-[#d4af37]/80 uppercase tracking-wider pb-1 pr-1.5">Entity</th>
                    <th className="text-left font-bold text-[9px] text-[#d4af37]/80 uppercase tracking-wider pb-1 pr-1.5">Rec</th>
                    <th className="text-right font-bold text-[9px] text-[#d4af37]/80 uppercase tracking-wider pb-1 pr-1.5">Tgt</th>
                    <th className="text-right font-bold text-[9px] text-[#d4af37]/80 uppercase tracking-wider pb-1">Date</th>
                  </tr>
                </thead>
                <tbody>
                  {firmGroups.map(g => {
                    const key = firmKey(g.firm);
                    const a = g.latest;
                    const color = GRADE_COLOR_CLASS[classifyGrade(a.toGrade)];
                    const hasHistory = g.history.length > 0;
                    const isOpen = expanded.has(key);
                    return (
                      <Fragment key={key}>
                        <tr className="border-b border-border/20">
                          <td className="py-1 pr-1 text-[10px] font-medium text-foreground whitespace-nowrap">
                            <span className="flex items-center gap-0 min-w-0">
                              <span className="truncate">{a.firm}</span>
                              {hasHistory && (
                                <span className="text-[9px] font-normal text-amber-200/40 tabular-nums leading-none">
                                  ({g.history.length + 1})
                                </span>
                              )}
                              <SourceBadge source={a.source} />
                              {hasHistory && (
                                <button
                                  type="button"
                                  onClick={() => toggleFirm(key)}
                                  className="inline-flex shrink-0 p-0 ml-0.5 text-amber-200/60 hover:text-[#d4af37] transition-colors"
                                  aria-expanded={isOpen}
                                  aria-label={isOpen ? "Hide prior ratings" : `Show ${g.history.length} prior`}
                                  title={isOpen ? "Hide prior" : `${g.history.length} prior`}
                                >
                                  {isOpen
                                    ? <ChevronDown className="w-2.5 h-2.5" />
                                    : <ChevronRight className="w-2.5 h-2.5" />}
                                </button>
                              )}
                            </span>
                          </td>
                          <td className={cn("py-1 pr-1.5 text-[10px] font-bold whitespace-nowrap", color)}>{gradeLabel(a)}</td>
                          <td className="py-1 pr-1.5 text-[10px] font-mono text-foreground text-right whitespace-nowrap">
                            {a.priceTarget != null ? `$${a.priceTarget.toFixed(2)}` : "—"}
                          </td>
                          <td className="py-1 text-[10px] text-amber-100 text-right whitespace-nowrap">{formatMdYy(a.date)}</td>
                        </tr>
                        {isOpen && g.history.map((h, hi) => {
                          const hColor = GRADE_COLOR_CLASS[classifyGrade(h.toGrade)];
                          return (
                            <tr key={`${key}-h${hi}`} className="border-b border-border/10 bg-secondary/10">
                              <td className="py-0.5 pr-1.5 pl-4 text-[9px] text-amber-200/50 whitespace-nowrap">
                                {h.action}
                              </td>
                              <td className={cn("py-0.5 pr-1.5 text-[9px] font-medium whitespace-nowrap", hColor)}>{gradeLabel(h)}</td>
                              <td className="py-0.5 pr-1.5 text-[9px] font-mono text-amber-100/60 text-right whitespace-nowrap">
                                {h.priceTarget != null ? `$${h.priceTarget.toFixed(2)}` : "—"}
                              </td>
                              <td className="py-0.5 text-[9px] text-amber-100/50 text-right whitespace-nowrap">{formatMdYy(h.date)}</td>
                            </tr>
                          );
                        })}
                      </Fragment>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}

          {analystPriceTargets.length > 0 ? (
            <div>
              <div className="text-[9px] text-[#d4af37] font-bold uppercase tracking-wider mb-1">
                Targets by firm
              </div>
              <div className="space-y-1">
                {analystPriceTargets.map((t, i) => {
                  const upside = t.priceTarget != null && m.currentPrice != null
                    ? ((t.priceTarget / m.currentPrice) - 1) * 100
                    : null;
                  const fromPosted = t.priceTarget != null && t.priceWhenPosted != null && t.priceWhenPosted > 0
                    ? ((t.priceTarget / t.priceWhenPosted) - 1) * 100
                    : null;
                  return (
                    <div key={i} className="border border-border/30 rounded px-2 py-1 bg-secondary/10">
                      <div className="flex items-center gap-1.5 flex-wrap">
                        <span className="text-[11px] font-bold text-foreground">{t.firm}</span>
                        {t.analyst && <span className="text-[9px] text-amber-200/50">({t.analyst})</span>}
                        <SourceBadge source={t.source} />
                        {t.priceTarget != null && (
                          <span className="ml-auto font-mono font-bold text-[11px] text-foreground tabular-nums">
                            ${t.priceTarget.toFixed(2)}
                          </span>
                        )}
                        {upside != null && (
                          <span className={cn("text-[10px] font-mono font-semibold tabular-nums", upside >= 0 ? "text-green-400" : "text-red-400")}>
                            {upside >= 0 ? "+" : ""}{upside.toFixed(1)}%
                          </span>
                        )}
                      </div>
                      {t.date && (
                        <div className="text-[9px] text-amber-100/80 mt-0.5 truncate">
                          {formatMdYy(t.date)}
                          {t.priceWhenPosted != null && ` · was $${t.priceWhenPosted.toFixed(2)}`}
                          {fromPosted != null && (
                            <span className={cn("ml-1 font-semibold", fromPosted >= 0 ? "text-green-300" : "text-red-300")}>
                              ({fromPosted >= 0 ? "+" : ""}{fromPosted.toFixed(0)}%)
                            </span>
                          )}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          ) : (
            <p className="text-[10px] text-amber-200/40 italic">No per-firm targets archived yet.</p>
          )}
      </div>
    </div>
  );
}
