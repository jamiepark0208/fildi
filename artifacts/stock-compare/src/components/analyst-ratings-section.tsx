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
  source?: "yahoo" | "fmp" | "headline" | "desk";
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
  desk: "Desk email",
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
      title={source === "headline" ? "Parsed from a news headline — lower confidence"
        : source === "desk" ? "From a desk newsletter (tradedash-brief); not in our Yahoo/FMP feeds" : "Archived from FMP's analyst feed"}
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
  const grade = (toGrade ?? "").toLowerCase();
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
  if (total === 0) return <p className="text-xs text-amber-100">No analyst data</p>;

  const bullishPct = ((recs.strongBuy + recs.buy) / total) * 100;
  const rating =
    bullishPct > 65
      ? "Buy"
      : bullishPct > 45
        ? "Outperform"
        : recs.hold / total > 0.5
          ? "Hold"
          : "Underperform";
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
        <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
          <span className="text-[9px] font-bold text-black bg-[#d4af37] px-1 py-0.5 rounded leading-none shadow-sm">
            {rating}
          </span>
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
        <div className="pt-0.5 text-[11px] font-semibold text-white border-t border-border/30 tabular-nums">
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

/** Compact grade tokens for the Rec column (color via classifyGrade on `to`). */
function abbreviateGrade(g: string): string {
  const x = (g ?? "").toLowerCase().replace(/[_-]+/g, " ").trim();
  if (!x) return "—";
  if (/strong\s*buy|conviction\s*buy/.test(x)) return "SB";
  if (/strong\s*sell/.test(x)) return "SS";
  if (/underweight|underperform|under\s*perform/.test(x)) return "U/W";
  if (/overweight|outperform|out\s*perform|accumulate|positive|sector\s*outperform/.test(x)) return "O/W";
  if (/^buy$|long[\s-]?term\s*buy|speculative\s*buy/.test(x)) return "Buy";
  if (/^sell$|reduce/.test(x)) return "Sell";
  if (/hold|neutral|equal[\s-]?weight|market\s*perform|in[\s-]?line|peer\s*perform|sector\s*perform/.test(x)) return "N";
  // Unknown vendor wording — keep short
  const words = g.trim().split(/\s+/);
  if (words.length === 1 && words[0]!.length <= 4) return words[0]!;
  return words.map((w) => w[0]!.toUpperCase()).join("").slice(0, 4);
}

function gradeLabel(a: AnalystAction): string {
  const from = a.fromGrade ? abbreviateGrade(a.fromGrade) : "";
  const to = a.toGrade ? abbreviateGrade(a.toGrade) : "";
  if (from && to && from !== to) return `${from}→${to}`;
  return to || from || "—";
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

  const [showTargets, setShowTargets] = useState(false);

  return (
    <div className="space-y-1.5 min-w-0">
      {/* Donut + consensus on one row — saves vertical space for the firm table */}
      <div className="flex items-start gap-2 min-w-0">
        <div className="shrink-0 scale-90 origin-top-left -mb-1">
          <AnalystDonut recs={recs} />
        </div>
        {m.analystTargetPrice != null && m.currentPrice != null && (
          <div className="min-w-0 flex-1 space-y-0.5 pt-0.5">
            <div className="flex items-baseline gap-1.5 text-[12px] font-mono flex-wrap">
              <span className="text-[10px] uppercase tracking-wider text-[#d4af37] font-sans font-bold">Px</span>
              <span className="tabular-nums text-white font-bold">${m.currentPrice.toFixed(2)}</span>
              <span className="text-amber-100/80">→</span>
              <span className="text-[10px] uppercase tracking-wider text-[#d4af37] font-sans font-bold">12M</span>
              <span className="tabular-nums font-bold text-white">${m.analystTargetPrice.toFixed(2)}</span>
            </div>
            {upsidePct != null && (
              <div className={cn("text-[13px] font-mono font-bold tabular-nums", upsidePct >= 0 ? "text-green-400" : "text-red-400")}>
                {upsidePct >= 0 ? "+" : ""}{upsidePct.toFixed(1)}%
              </div>
            )}
            {hasRange && (
              <div className="pt-0.5">
                <div className="relative h-1.5 bg-secondary/50 rounded-full overflow-visible mb-0.5">
                  <div className="absolute inset-0 rounded-full bg-gradient-to-r from-red-500/20 via-yellow-500/15 to-green-500/20" />
                  {meanPct != null && (
                    <div
                      className="absolute top-1/2 -translate-y-1/2 -translate-x-1/2 w-1 h-2.5 bg-yellow-400/80 rounded-sm"
                      style={{ left: `${meanPct}%` }}
                      title={`Mean $${pt!.mean!.toFixed(2)}`}
                    />
                  )}
                  {pricePct != null && (
                    <div
                      className="absolute top-1/2 -translate-y-1/2 -translate-x-1/2 w-2 h-2 bg-primary rounded-full border border-background z-10"
                      style={{ left: `${pricePct}%` }}
                      title={`Current $${m.currentPrice.toFixed(2)}`}
                    />
                  )}
                </div>
                <div className="flex justify-between text-[8px] font-mono text-amber-50/80 gap-0.5">
                  <span>${pt!.low!.toFixed(0)}</span>
                  {pt!.mean != null && <span className="text-yellow-300">μ${pt!.mean!.toFixed(0)}</span>}
                  <span>${pt!.high!.toFixed(0)}</span>
                </div>
              </div>
            )}
          </div>
        )}
      </div>

      {firmGroups.length > 0 && (
        <div className="min-w-0 border-t border-border/30 pt-1">
          {/* Horizontal scroll — Rec/Tgt/Date were clipped by the fixed-width panel */}
          <div className="overflow-x-auto overscroll-x-contain -mx-0.5 px-0.5" data-lenis-prevent>
            <table className="w-max min-w-full border-collapse">
              <thead>
                <tr className="border-b border-border/40">
                  <th className="text-left font-bold text-[8px] text-[#d4af37]/80 uppercase tracking-wider pb-0.5 pr-2 sticky left-0 bg-zinc-950 z-[1]">Entity</th>
                  <th className="text-left font-bold text-[8px] text-[#d4af37]/80 uppercase tracking-wider pb-0.5 pr-2">Rec</th>
                  <th className="text-right font-bold text-[8px] text-[#d4af37]/80 uppercase tracking-wider pb-0.5 pr-2">Tgt</th>
                  <th className="text-right font-bold text-[8px] text-[#d4af37]/80 uppercase tracking-wider pb-0.5">Date</th>
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
                        <td className="py-0.5 pr-1.5 text-[10px] font-medium text-foreground whitespace-nowrap sticky left-0 bg-zinc-950 z-[1]">
                          <span className="flex items-center gap-0.5">
                            <span className="max-w-[7.5rem] truncate">{a.firm}</span>
                            {hasHistory && (
                              <span className="text-[8px] font-normal text-amber-200/40 tabular-nums">
                                ({g.history.length + 1})
                              </span>
                            )}
                            <SourceBadge source={a.source} />
                            {hasHistory && (
                              <button
                                type="button"
                                onClick={() => toggleFirm(key)}
                                className="inline-flex shrink-0 p-0 text-amber-200/60 hover:text-[#d4af37] transition-colors"
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
                        <td className={cn("py-0.5 pr-2 text-[10px] font-bold whitespace-nowrap", color)}>{gradeLabel(a)}</td>
                        <td className="py-0.5 pr-2 text-[10px] font-mono text-foreground text-right whitespace-nowrap">
                          {a.priceTarget != null ? `$${a.priceTarget.toFixed(2)}` : "—"}
                        </td>
                        <td className="py-0.5 text-[10px] text-amber-100 text-right whitespace-nowrap">{formatMdYy(a.date)}</td>
                      </tr>
                      {isOpen && g.history.map((h, hi) => {
                        const hColor = GRADE_COLOR_CLASS[classifyGrade(h.toGrade)];
                        return (
                          <tr key={`${key}-h${hi}`} className="border-b border-border/10 bg-secondary/10">
                            <td className="py-0.5 pr-1.5 pl-2 text-[9px] text-amber-200/50 whitespace-nowrap sticky left-0 bg-zinc-900 z-[1]">
                              {h.action}
                            </td>
                            <td className={cn("py-0.5 pr-2 text-[9px] font-medium whitespace-nowrap", hColor)}>{gradeLabel(h)}</td>
                            <td className="py-0.5 pr-2 text-[9px] font-mono text-amber-100/60 text-right whitespace-nowrap">
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
        </div>
      )}

      {analystPriceTargets.length > 0 ? (
        <div className="border-t border-border/30 pt-1 min-w-0">
          <button
            type="button"
            onClick={() => setShowTargets((v) => !v)}
            className="text-[9px] text-[#d4af37] font-bold uppercase tracking-wider mb-0.5 hover:text-[#f0d060]"
          >
            Targets by firm {showTargets ? "▴" : "▾"} ({analystPriceTargets.length})
          </button>
          {showTargets && (
            <div className="space-y-0.5">
              {analystPriceTargets.map((t, i) => {
                const upside = t.priceTarget != null && m.currentPrice != null
                  ? ((t.priceTarget / m.currentPrice) - 1) * 100
                  : null;
                return (
                  <div key={i} className="flex items-center gap-1.5 text-[10px] min-w-0">
                    <span className="font-semibold text-foreground truncate min-w-0">{t.firm}</span>
                    {t.priceTarget != null && (
                      <span className="ml-auto font-mono font-bold text-foreground tabular-nums shrink-0">
                        ${t.priceTarget.toFixed(2)}
                      </span>
                    )}
                    {upside != null && (
                      <span className={cn("text-[9px] font-mono font-semibold tabular-nums shrink-0", upside >= 0 ? "text-green-400" : "text-red-400")}>
                        {upside >= 0 ? "+" : ""}{upside.toFixed(0)}%
                      </span>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      ) : null}
    </div>
  );
}
