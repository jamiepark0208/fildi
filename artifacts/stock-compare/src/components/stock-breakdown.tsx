import { useState, useRef, useCallback, useEffect, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { useLocation } from "wouter";
import {
  Loader2, Search, ExternalLink, AlertCircle, BarChart2, TrendingUp, TrendingDown, ChevronDown, ChevronUp, LineChart
} from "lucide-react";
import {
  PieChart, Pie, Cell,
} from "recharts";
import { PriceChart, Period } from "./price-chart";
import { CompetitorsSection } from "./competitors-section";
import { CatalystsSection } from "./catalysts-section";
import { useSearchStocks, getSearchStocksQueryKey } from "@workspace/api-client-react";
import { useDebounce } from "@/hooks/use-debounce";
import { cn } from "@/lib/utils";
import { formatCurrency, formatLargeNumber, formatNumber, formatPercent } from "@/lib/format";
import { addToScannerShelf } from "@/lib/ticker-shelf-storage";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

// ── Types ──────────────────────────────────────────────────────────────────────

interface SnowflakeScores {
  value: number;
  growth: number;
  health: number;
  past: number;
  dividend: number;
}

interface NewsItem {
  title: string;
  link: string;
  publisher: string;
  publishedAt: string | null;
}

interface Recommendations {
  strongBuy: number;
  buy: number;
  hold: number;
  sell: number;
  strongSell: number;
}

interface AnalystAction {
  firm: string;
  toGrade: string;
  fromGrade: string;
  action: string;
  date: string | null;
}

interface AnalystPriceTarget {
  firm: string;
  analyst: string | null;
  priceTarget: number | null;
  date: string | null;
  priceWhenPosted: number | null;
  newsTitle: string | null;
}

interface PriceTargetRange {
  high: number | null;
  low: number | null;
  mean: number | null;
  median: number | null;
}

interface BreakdownData {
  metrics: any;
  snowflake: SnowflakeScores;
  recommendations: Recommendations | null;
  analystActions: AnalystAction[];
  analystPriceTargets: AnalystPriceTarget[];
  priceTargetRange: PriceTargetRange | null;
  bullBullets: string[];
  bearBullets: string[];
  news: NewsItem[];
  earningsDate?: string | null;
  catalysts?: string[];
  peers?: string[];
  peerIndustry?: string | null;
  peerSector?: string | null;
}

// ── Data fetching ──────────────────────────────────────────────────────────────

function useBreakdown(ticker: string | null) {
  return useQuery<BreakdownData, Error>({
    queryKey: ["breakdown", ticker],
    queryFn: async () => {
      const res = await fetch(`/api/stocks/breakdown?ticker=${encodeURIComponent(ticker!)}`);
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error((err as any).error || `HTTP ${res.status}`);
      }
      return res.json();
    },
    enabled: !!ticker,
    staleTime: 10 * 60 * 1000,
    gcTime: 15 * 60 * 1000,
    retry: 1,
  });
}

// ── Sub-components ─────────────────────────────────────────────────────────────

function overviewBullets(description: string, companyName: string | null | undefined): string[] {
  const sentences = description.split(/(?<=[.!?])\s+/);
  const filtered = sentences.filter((s, i) => {
    if (i !== 0) return true;
    if (!companyName?.trim()) return true;
    const trimmed = s.trim();
    const name = companyName.trim();
    if (trimmed.toLowerCase().startsWith(name.toLowerCase())) return false;
    if (trimmed.replace(/[.!?]+$/, "").toLowerCase() === name.toLowerCase()) return false;
    return true;
  });
  return filtered.slice(0, 3);
}

function ScoreBadge({ score, max = 5 }: { score: number; max?: number }) {
  const color =
    score >= 4 ? "text-green-400" : score >= 3 ? "text-yellow-400" : score >= 2 ? "text-orange-400" : "text-red-400";
  return (
    <span className={cn("font-bold font-mono tabular-nums text-sm", color)}>
      {score}/{max}
    </span>
  );
}

interface MetricRowData {
  label: string;
  value: string;
  good?: boolean;
}

interface MetricGroup {
  title: string;
  score: number;
  rows: MetricRowData[];
}

function MetricsTable({ groups }: { groups: MetricGroup[] }) {
  return (
    <div className="grid grid-cols-4 gap-2">
      {groups.map(group => (
        <div key={group.title} className="bg-card border border-border/50 rounded-lg p-2.5">
          <div className="flex items-center justify-between mb-1.5">
            <span className="text-[11px] font-bold tracking-tight text-foreground truncate">
              {group.title}
            </span>
            <ScoreBadge score={group.score} />
          </div>
          <div className="space-y-1">
            {group.rows.map((row, i) => (
              <div key={i} className="flex justify-between items-center gap-1.5">
                <span className="text-[10px] text-foreground truncate">{row.label}</span>
                <span
                  className={cn(
                    "text-[10px] font-mono font-semibold shrink-0",
                    row.good === true ? "text-green-400" : row.good === false ? "text-red-400" : "text-foreground",
                  )}
                >
                  {row.value}
                </span>
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

function gradeColor(grade: string): string {
  const g = grade.toLowerCase();
  if (g.includes("strong buy") || g.includes("outperform") || g.includes("overweight") || g === "buy" || g === "positive") return "text-green-400";
  if (g.includes("strong sell") || g.includes("underperform") || g.includes("underweight") || g === "sell" || g === "negative") return "text-red-400";
  if (g === "neutral" || g === "hold" || g === "equal-weight" || g === "market perform" || g === "peer perform") return "text-yellow-400";
  return "text-muted-foreground";
}

function actionLabel(action: string): string {
  if (action === "up") return "↑ Upgrade";
  if (action === "down") return "↓ Downgrade";
  if (action === "init") return "● Initiated";
  if (action === "reit") return "→ Reiterated";
  return "→ Maintain";
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

function AnalystRatingsSection({
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

function MarketSentimentSection({
  recs, bullBullets, bearBullets,
}: {
  recs: Recommendations | null;
  bullBullets: string[];
  bearBullets: string[];
}) {
  const total = recs ? recs.strongBuy + recs.buy + recs.hold + recs.sell + recs.strongSell : 0;
  const bullPct = total > 0 ? Math.round(((recs!.strongBuy + recs!.buy) / total) * 100) : 0;
  const neutralPct = total > 0 ? Math.round((recs!.hold / total) * 100) : 0;
  const bearPct = total > 0 ? 100 - bullPct - neutralPct : 0;

  const hasSentiment = total > 0;
  const hasBullets = bullBullets.length > 0 || bearBullets.length > 0;
  if (!hasSentiment && !hasBullets) return null;

  return (
    <div className="bg-card border border-border/50 rounded-xl p-4 space-y-5">
      <span className="text-base font-bold tracking-tight text-foreground block">Market Sentiment</span>

      {/* Bullish / Neutral / Bearish bar */}
      {hasSentiment && (
        <div>
          <div className="text-[10px] text-foreground uppercase tracking-widest mb-2">Wall St. Consensus</div>
          <div className="flex h-3 rounded-full overflow-hidden gap-px">
            {bullPct > 0 && (
              <div className="bg-green-500/80 transition-all" style={{ width: `${bullPct}%` }} />
            )}
            {neutralPct > 0 && (
              <div className="bg-yellow-500/60 transition-all" style={{ width: `${neutralPct}%` }} />
            )}
            {bearPct > 0 && (
              <div className="bg-red-500/70 transition-all" style={{ width: `${bearPct}%` }} />
            )}
          </div>
          <div className="flex justify-between mt-2 text-[11px]">
            <span className="text-green-400 font-semibold">{bullPct}% Bullish</span>
            <span className="text-yellow-400/80">{neutralPct}% Neutral</span>
            <span className="text-red-400 font-semibold">{bearPct}% Bearish</span>
          </div>
          <div className="text-[10px] text-foreground mt-1">Based on {total} Wall St. analyst recommendations</div>
        </div>
      )}

      {/* Bull / Bear table */}
      {hasBullets && (
        <div className="grid grid-cols-2 gap-3">
          <div className="border border-green-500/20 rounded-lg p-3 bg-green-500/5">
            <div className="flex items-center gap-1.5 mb-2">
              <TrendingUp className="w-3.5 h-3.5 text-green-400" />
              <span className="text-[10px] font-bold uppercase tracking-widest text-green-400">Bull Case</span>
            </div>
            <ul className="space-y-1.5">
              {bullBullets.map((b, i) => (
                <li key={i} className="text-[11px] text-foreground flex gap-1.5">
                  <span className="shrink-0 text-green-500/70 mt-0.5">▲</span>
                  {b}
                </li>
              ))}
              {bullBullets.length === 0 && (
                <li className="text-[11px] text-foreground italic">No strong bull signals from current metrics</li>
              )}
            </ul>
          </div>
          <div className="border border-red-500/20 rounded-lg p-3 bg-red-500/5">
            <div className="flex items-center gap-1.5 mb-2">
              <TrendingDown className="w-3.5 h-3.5 text-red-400" />
              <span className="text-[10px] font-bold uppercase tracking-widest text-red-400">Bear Case</span>
            </div>
            <ul className="space-y-1.5">
              {bearBullets.map((b, i) => (
                <li key={i} className="text-[11px] text-foreground flex gap-1.5">
                  <span className="shrink-0 text-red-500/70 mt-0.5">▼</span>
                  {b}
                </li>
              ))}
              {bearBullets.length === 0 && (
                <li className="text-[11px] text-foreground italic">No significant bear signals from current metrics</li>
              )}
            </ul>
          </div>
        </div>
      )}
    </div>
  );
}

function AnalystDonut({ recs }: { recs: Recommendations }) {
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

function timeAgo(iso: string | null): string {
  if (!iso) return "";
  const diff = Date.now() - new Date(iso).getTime();
  const h = Math.floor(diff / 3_600_000);
  if (h < 1) return "< 1h ago";
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

function NewsCard({ item }: { item: NewsItem }) {
  if (!item.link) return null;
  return (
    <a
      href={item.link}
      target="_blank"
      rel="noopener noreferrer"
      className="flex items-start gap-3 p-3 rounded-lg hover:bg-secondary/40 transition-colors border border-transparent hover:border-border/40 group"
    >
      <div className="flex-1 min-w-0">
        <p className="text-sm font-medium leading-snug group-hover:text-primary transition-colors line-clamp-2">
          {item.title}
        </p>
        <div className="flex items-center gap-1.5 mt-1.5 text-[11px] text-foreground">
          {item.publisher && <span className="font-medium">{item.publisher}</span>}
          {item.publishedAt && (
            <>
              <span>·</span>
              <span>{timeAgo(item.publishedAt)}</span>
            </>
          )}
        </div>
      </div>
      <ExternalLink className="w-3.5 h-3.5 text-muted-foreground/40 shrink-0 mt-0.5 group-hover:text-primary/60 transition-colors" />
    </a>
  );
}

// ── Main component ─────────────────────────────────────────────────────────────

export function StockBreakdown({ ticker: propTicker }: { ticker?: string } = {}) {
  const [, navigate] = useLocation();
  const [inputText, setInputText] = useState(propTicker ?? "");
  const [activeTicker, setActiveTicker] = useState<string | null>(propTicker ?? null);
  const [chartPeriod, setChartPeriod] = useState<Period>("3M");
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const [focusedIdx, setFocusedIdx] = useState(-1);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // When driven by watchlist click, sync ticker from prop
  useEffect(() => {
    if (propTicker) {
      setActiveTicker(propTicker);
      setInputText(propTicker);
      setChartPeriod("3M");
    }
  }, [propTicker]);

  const debouncedQuery = useDebounce(inputText, 180);

  const { data: searchResults, isFetching: isSearching } = useSearchStocks(
    { q: debouncedQuery },
    {
      query: {
        enabled: debouncedQuery.length >= 1,
        queryKey: getSearchStocksQueryKey({ q: debouncedQuery }),
        staleTime: 5 * 60 * 1000,
      },
    },
  );

  const suggestions =
    dropdownOpen && (searchResults?.length ?? 0) > 0 ? searchResults! : [];

  const { data, isLoading, error } = useBreakdown(activeTicker);

  const commitTicker = useCallback((t: string) => {
    const upper = t.trim().toUpperCase();
    if (!upper) return;
    setActiveTicker(upper);
    setInputText(upper);
    setDropdownOpen(false);
    setFocusedIdx(-1);
    setChartPeriod("3M");
  }, []);

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setInputText(e.target.value.toUpperCase());
    setDropdownOpen(true);
    setFocusedIdx(-1);
  };

  const handleFocus = () => {
    if (closeTimer.current) clearTimeout(closeTimer.current);
    if (inputText.length >= 1) setDropdownOpen(true);
  };

  const handleBlur = () => {
    closeTimer.current = setTimeout(() => setDropdownOpen(false), 150);
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      e.preventDefault();
      if (focusedIdx >= 0 && suggestions[focusedIdx]) {
        commitTicker(suggestions[focusedIdx].ticker);
      } else {
        commitTicker(inputText);
      }
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      setFocusedIdx((i) => Math.min(i + 1, suggestions.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setFocusedIdx((i) => Math.max(i - 1, 0));
    } else if (e.key === "Escape") {
      setDropdownOpen(false);
    }
  };

  const m = data?.metrics;
  const dayUp = (m?.dayChange ?? 0) >= 0;

  return (
    <div className="h-full flex flex-col overflow-hidden">
      {/* Search header — hidden when ticker is driven by parent (e.g. watchlist) */}
      {!propTicker && <div className="shrink-0 border-b border-border/40 bg-background/95 backdrop-blur px-6 py-3 z-10">
        <div className="max-w-3xl mx-auto flex gap-2">
          <div className="relative flex-1">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground pointer-events-none z-10" />
            {isSearching && debouncedQuery.length >= 1 && (
              <Loader2 className="absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground animate-spin z-10" />
            )}
            <input
              type="text"
              autoComplete="off"
              spellCheck={false}
              value={inputText}
              onChange={handleChange}
              onFocus={handleFocus}
              onBlur={handleBlur}
              onKeyDown={handleKeyDown}
              placeholder="Enter ticker (e.g. AAPL, TSLA, MSFT)…"
              className="w-full h-10 pl-9 pr-9 text-sm font-mono bg-background border border-border rounded-lg focus:outline-none focus:ring-1 focus:ring-primary focus:border-primary transition-colors"
            />
            {dropdownOpen && suggestions.length > 0 && (
              <ul className="absolute top-full left-0 right-0 mt-1 z-50 bg-card border border-border rounded-lg shadow-xl overflow-hidden max-h-52 overflow-y-auto">
                {suggestions.map((r, i) => (
                  <li
                    key={r.ticker}
                    onMouseDown={(e) => {
                      e.preventDefault();
                      commitTicker(r.ticker);
                    }}
                    className={cn(
                      "px-3 py-2 text-sm cursor-pointer flex items-center justify-between hover:bg-primary/10",
                      i === focusedIdx && "bg-primary/10",
                    )}
                  >
                    <span className="font-mono font-bold">{r.ticker}</span>
                    <span className="text-muted-foreground text-xs truncate ml-2 max-w-[180px]">
                      {r.name}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>
          <button
            onClick={() => commitTicker(inputText)}
            className="px-5 h-10 bg-primary text-primary-foreground text-sm font-semibold rounded-lg hover:bg-primary/90 transition-colors shrink-0"
          >
            Analyze
          </button>
        </div>
      </div>}

      {/* Content area */}
      <div className="flex-1 overflow-y-auto">
        {/* Empty state */}
        {!activeTicker && (
          <div className="h-full flex flex-col items-center justify-center text-center text-muted-foreground/60 gap-4 py-20">
            <div className="w-16 h-16 rounded-2xl bg-secondary/50 flex items-center justify-center border border-dashed border-border">
              <BarChart2 className="w-8 h-8" />
            </div>
            <div>
              <p className="text-sm font-medium">Enter a ticker to get the full breakdown</p>
              <p className="text-xs mt-1 text-muted-foreground/40">
                Valuation · Growth · Health · Analyst Ratings · News
              </p>
            </div>
          </div>
        )}

        {/* Loading */}
        {activeTicker && isLoading && (
          <div className="h-full flex items-center justify-center py-20">
            <div className="flex flex-col items-center gap-3 text-muted-foreground">
              <Loader2 className="w-8 h-8 animate-spin" />
              <span className="text-sm">Loading {activeTicker}…</span>
            </div>
          </div>
        )}

        {/* Error */}
        {error && (
          <div className="max-w-3xl mx-auto px-6 pt-8">
            <div className="flex items-start gap-3 bg-red-500/10 border border-red-500/20 text-red-400 rounded-xl p-4">
              <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
              <span className="text-sm">{error.message}</span>
            </div>
          </div>
        )}

        {/* Main content */}
        {m && !isLoading && (
          <div className="max-w-3xl mx-auto px-6 py-6 space-y-5 pb-12">
            {/* ── Header ── */}
            <div className="flex items-start justify-between gap-4">
              <div className="min-w-0">
                <div className="flex items-baseline gap-2 flex-wrap">
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <h1 className="text-2xl font-bold font-mono tracking-tight shrink-0 cursor-help decoration-dotted underline-offset-4 hover:underline">
                        {m.ticker}
                      </h1>
                    </TooltipTrigger>
                    <TooltipContent side="bottom" align="start" className="max-w-sm bg-card text-foreground border border-border p-3">
                      <span className="text-xs font-bold tracking-tight text-foreground block mb-1.5">Company Overview</span>
                      {m.description ? (
                        <ul className="space-y-1.5">
                          {overviewBullets(m.description, m.companyName).map((s: string, i: number) => (
                            <li key={i} className="flex gap-1.5 text-xs text-foreground leading-snug">
                              <span className="shrink-0 text-foreground mt-0.5">•</span>
                              {s}
                            </li>
                          ))}
                        </ul>
                      ) : (
                        <p className="text-xs text-foreground">No description available.</p>
                      )}
                    </TooltipContent>
                  </Tooltip>
                  <span className="text-base text-foreground font-medium truncate">
                    {m.companyName}
                  </span>
                </div>
                <div className="flex flex-wrap items-center gap-1.5 mt-1.5">
                  {m.exchange && (
                    <span className="text-[10px] bg-secondary/60 border border-border/40 px-2 py-0.5 rounded-md font-mono text-foreground">
                      {m.exchange}
                    </span>
                  )}
                  {m.sector && (
                    <span className="text-[10px] text-foreground">{m.sector}</span>
                  )}
                  {m.industry && (
                    <>
                      <span className="text-[10px] text-foreground">·</span>
                      <span className="text-[10px] text-foreground">{m.industry}</span>
                    </>
                  )}
                  {m.stockType && (
                    <>
                      <span className="text-[10px] text-foreground">·</span>
                      <span className="text-[10px] text-foreground">{m.stockType}</span>
                    </>
                  )}
                  {m.beta != null && (
                    <>
                      <span className="text-[10px] text-foreground">·</span>
                      <span className="text-[10px] text-foreground">Beta {formatNumber(m.beta)}</span>
                    </>
                  )}
                  {m.fairValueEstimate != null && (
                    <>
                      <span className="text-[10px] text-foreground">·</span>
                      <span className="text-[10px] text-foreground">Fair Value {formatCurrency(m.fairValueEstimate)}</span>
                    </>
                  )}
                </div>
                <div className="flex items-center gap-1.5 mt-2">
                  <button
                    type="button"
                    onClick={() => { addToScannerShelf(m.ticker); navigate("/options-scanner"); }}
                    className="flex items-center gap-1 text-[11px] font-medium text-white bg-green-600 hover:bg-green-500 rounded-md px-2.5 py-1 transition-colors"
                  >
                    <LineChart className="w-3 h-3" /> Open in Options Scanner
                  </button>
                </div>
              </div>

              <div className="text-right shrink-0">
                <div className="text-3xl font-bold font-mono tracking-tight">
                  {m.currentPrice != null ? `$${m.currentPrice.toFixed(2)}` : "—"}
                </div>
                <div
                  className={cn(
                    "flex items-center justify-end gap-1 text-sm font-mono font-semibold mt-0.5",
                    dayUp ? "text-green-400" : "text-red-400",
                  )}
                >
                  {dayUp ? (
                    <TrendingUp className="w-3.5 h-3.5" />
                  ) : (
                    <TrendingDown className="w-3.5 h-3.5" />
                  )}
                  {dayUp ? "+" : ""}
                  {m.dayChange?.toFixed(2)} ({dayUp ? "+" : ""}
                  {((m.dayChangePercent ?? 0) * 100).toFixed(2)}%)
                </div>
                <div className="text-[11px] text-foreground mt-0.5">
                  Mkt Cap: {formatLargeNumber(m.marketCap)}
                </div>
              </div>
            </div>

            {/* ── Top reward / risk summary ── */}
            {(data.bullBullets?.[0] || data.bearBullets?.[0]) && (
              <div className="grid grid-cols-2 gap-3">
                {data.bullBullets?.[0] && (
                  <div className="flex gap-1.5 text-[12px] text-foreground leading-snug border-l-2 border-green-500/50 pl-2.5 py-0.5">
                    <span className="shrink-0 text-green-500/70 mt-0.5">▲</span>
                    {data.bullBullets[0]}
                  </div>
                )}
                {data.bearBullets?.[0] && (
                  <div className="flex gap-1.5 text-[12px] text-foreground leading-snug border-l-2 border-red-500/50 pl-2.5 py-0.5">
                    <span className="shrink-0 text-red-500/70 mt-0.5">▼</span>
                    {data.bearBullets[0]}
                  </div>
                )}
              </div>
            )}

            {/* ── Metrics table ── */}
            <MetricsTable
              groups={[
                {
                  title: "Valuation",
                  score: data.snowflake.value,
                  rows: [
                    { label: "P/E Ratio", value: formatNumber(m.peRatio) },
                    { label: "PEG Ratio", value: formatNumber(m.pegRatio), good: m.pegRatio != null ? m.pegRatio < 1.5 : undefined },
                    { label: "Price / Book", value: formatNumber(m.priceToBook) },
                    { label: "Price / Sales", value: formatNumber(m.priceToSales) },
                    ...(m.analystTargetPrice != null
                      ? [{ label: "Analyst Target", value: formatCurrency(m.analystTargetPrice) }]
                      : []),
                    ...(m.analystTargetPrice != null && m.currentPrice != null
                      ? [{
                          label: "Upside to Target",
                          value: `${((m.analystTargetPrice / m.currentPrice - 1) * 100).toFixed(1)}%`,
                          good: m.analystTargetPrice > m.currentPrice,
                        }]
                      : []),
                    ...(m.fairValueEstimate != null && m.currentPrice != null
                      ? [{
                          label: "Fair Value Est.",
                          value: formatCurrency(m.fairValueEstimate),
                          good: m.fairValueEstimate > m.currentPrice,
                        }]
                      : []),
                  ],
                },
                {
                  title: "Future Growth",
                  score: data.snowflake.growth,
                  rows: [
                    { label: "Revenue Growth (YoY)", value: formatPercent(m.revenueGrowthYoY), good: m.revenueGrowthYoY != null ? m.revenueGrowthYoY > 0 : undefined },
                    { label: "EPS Growth", value: formatPercent(m.epsGrowth), good: m.epsGrowth != null ? m.epsGrowth > 0 : undefined },
                    { label: "EPS (Trailing)", value: formatCurrency(m.earningsPerShare) },
                    { label: "Total Revenue", value: formatLargeNumber(m.totalRevenue) },
                    { label: "EBITDA", value: formatLargeNumber(m.ebitda) },
                  ],
                },
                {
                  title: "Past Performance",
                  score: data.snowflake.past,
                  rows: [
                    { label: "Return on Equity", value: formatPercent(m.returnOnEquity), good: m.returnOnEquity != null ? m.returnOnEquity > 0.1 : undefined },
                    { label: "Return on Assets", value: formatPercent(m.returnOnAssets), good: m.returnOnAssets != null ? m.returnOnAssets > 0 : undefined },
                    { label: "Gross Margin", value: formatPercent(m.grossMargin) },
                    { label: "Operating Margin", value: formatPercent(m.operatingMargin) },
                    { label: "Net Margin", value: formatPercent(m.netMargin), good: m.netMargin != null ? m.netMargin > 0.08 : undefined },
                    { label: "Free Cash Flow", value: formatLargeNumber(m.freeCashFlow) },
                  ],
                },
                {
                  title: "Financial Health",
                  score: data.snowflake.health,
                  rows: [
                    { label: "Current Ratio", value: formatNumber(m.currentRatio), good: m.currentRatio != null ? m.currentRatio > 1.5 : undefined },
                    { label: "Debt / Equity", value: formatNumber(m.debtToEquity), good: m.debtToEquity != null ? m.debtToEquity < 0.5 : undefined },
                    { label: "Net Income", value: formatLargeNumber(m.netIncome) },
                    { label: "Dividend Yield", value: formatPercent(m.dividendYield), good: m.dividendYield != null && m.dividendYield > 0 ? true : undefined },
                  ],
                },
              ]}
            />

            {/* ── Price Chart ── */}
            <div className="overflow-hidden">
              <PriceChart
                tickers={[m.ticker]}
                loadedStocks={[m]}
                selectedPeriod={chartPeriod}
                onPeriodChange={setChartPeriod}
                showTechnicalZones={!!propTicker}
                tickerForTechnicals={propTicker}
              />
            </div>

            {/* ── Analyst Ratings ── */}
            {data.recommendations && (
              <AnalystRatingsSection
                recs={data.recommendations}
                metrics={m}
                analystActions={data.analystActions ?? []}
                analystPriceTargets={data.analystPriceTargets ?? []}
                priceTargetRange={data.priceTargetRange ?? null}
              />
            )}

            {/* ── Market Sentiment ── */}
            {(data.bullBullets?.length > 0 || data.bearBullets?.length > 0 || data.recommendations) && (
              <MarketSentimentSection
                recs={data.recommendations}
                bullBullets={data.bullBullets ?? []}
                bearBullets={data.bearBullets ?? []}
              />
            )}

            <CatalystsSection catalysts={data.catalysts} />

            {propTicker && activeTicker && (
              <CompetitorsSection ticker={activeTicker} />
            )}

            {/* ── Recent News ── */}
            {data.news && data.news.length > 0 && (
              <div className="bg-card border border-border/50 rounded-xl p-4">
                <span className="text-base font-bold tracking-tight text-foreground block mb-2">
                  Recent News & Updates
                </span>
                <div className="space-y-0.5 -mx-1 mt-2">
                  {data.news.map((item, i) => (
                    <NewsCard key={i} item={item} />
                  ))}
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
