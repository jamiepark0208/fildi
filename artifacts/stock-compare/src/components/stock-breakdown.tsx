import { useState, useRef, useCallback } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  Loader2, Search, ExternalLink, AlertCircle, BarChart2, TrendingUp, TrendingDown
} from "lucide-react";
import {
  RadarChart, PolarGrid, PolarAngleAxis, Radar, ResponsiveContainer,
  PieChart, Pie, Cell,
} from "recharts";
import { PriceChart, Period } from "./price-chart";
import { useSearchStocks, getSearchStocksQueryKey } from "@workspace/api-client-react";
import { useDebounce } from "@/hooks/use-debounce";
import { cn } from "@/lib/utils";
import { formatCurrency, formatLargeNumber, formatNumber, formatPercent } from "@/lib/format";

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

interface BreakdownData {
  metrics: any;
  snowflake: SnowflakeScores;
  recommendations: Recommendations | null;
  news: NewsItem[];
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

function ScoreBadge({ score, max = 5 }: { score: number; max?: number }) {
  const color =
    score >= 4 ? "text-green-400" : score >= 3 ? "text-yellow-400" : score >= 2 ? "text-orange-400" : "text-red-400";
  return (
    <span className={cn("font-bold font-mono tabular-nums text-sm", color)}>
      {score}/{max}
    </span>
  );
}

function SnowflakeChart({ scores }: { scores: SnowflakeScores }) {
  const data = [
    { dimension: "Value", score: scores.value, fullMark: 5 },
    { dimension: "Future", score: scores.growth, fullMark: 5 },
    { dimension: "Past", score: scores.past, fullMark: 5 },
    { dimension: "Health", score: scores.health, fullMark: 5 },
    { dimension: "Dividend", score: scores.dividend, fullMark: 5 },
  ];

  return (
    <ResponsiveContainer width="100%" height={220}>
      <RadarChart data={data} outerRadius="75%">
        <PolarGrid
          gridType="polygon"
          stroke="rgba(255,255,255,0.08)"
          radialLines={true}
        />
        <PolarAngleAxis
          dataKey="dimension"
          tick={{ fill: "hsl(var(--muted-foreground))", fontSize: 10, fontWeight: 600, letterSpacing: 0.5 }}
        />
        <Radar
          name="Score"
          dataKey="score"
          stroke="hsl(var(--primary))"
          fill="hsl(var(--primary))"
          fillOpacity={0.28}
          strokeWidth={2}
          dot={{ r: 3, fill: "hsl(var(--primary))", strokeWidth: 0 }}
        />
      </RadarChart>
    </ResponsiveContainer>
  );
}

function MetricRow({
  label,
  value,
  good,
}: {
  label: string;
  value: string;
  good?: boolean;
}) {
  return (
    <div className="flex justify-between items-center py-1.5 border-b border-border/20 last:border-0">
      <span className="text-xs text-muted-foreground">{label}</span>
      <span
        className={cn(
          "text-xs font-mono font-semibold",
          good === true && "text-green-400",
          good === false && "text-red-400",
        )}
      >
        {value}
      </span>
    </div>
  );
}

function SectionCard({
  title,
  score,
  children,
}: {
  title: string;
  score?: number;
  children: React.ReactNode;
}) {
  return (
    <div className="bg-card border border-border/50 rounded-xl p-4">
      <div className="flex items-center justify-between mb-3">
        <span className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground">
          {title}
        </span>
        {score !== undefined && <ScoreBadge score={score} />}
      </div>
      {children}
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
            <span className="text-muted-foreground">{d.name}</span>
            <span className="font-mono ml-auto pl-3 font-medium">{d.value}</span>
          </div>
        ))}
        <div className="pt-0.5 text-[11px] text-muted-foreground border-t border-border/30">
          {total} analyst{total !== 1 ? "s" : ""}
        </div>
      </div>
    </div>
  );
}

function RangeBar({
  current,
  low,
  high,
}: {
  current: number;
  low: number;
  high: number;
}) {
  const pct = high > low ? Math.max(2, Math.min(98, ((current - low) / (high - low)) * 100)) : 50;
  return (
    <div>
      <div className="flex justify-between text-[10px] text-muted-foreground mb-1.5">
        <span>52W Low: ${low.toFixed(2)}</span>
        <span>52W High: ${high.toFixed(2)}</span>
      </div>
      <div className="relative h-2 bg-secondary/50 rounded-full overflow-visible">
        <div className="absolute inset-0 rounded-full bg-gradient-to-r from-red-500/25 via-yellow-500/20 to-green-500/25" />
        <div
          className="absolute top-1/2 -translate-y-1/2 -translate-x-1/2 w-3 h-3 bg-primary rounded-full shadow-sm shadow-primary/50 border-2 border-background z-10"
          style={{ left: `${pct}%` }}
        />
      </div>
      <div className="text-center text-xs font-mono font-semibold mt-2 text-foreground">
        ${current.toFixed(2)}
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
        <div className="flex items-center gap-1.5 mt-1.5 text-[11px] text-muted-foreground">
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

export function StockBreakdown() {
  const [inputText, setInputText] = useState("");
  const [activeTicker, setActiveTicker] = useState<string | null>(null);
  const [chartPeriod, setChartPeriod] = useState<Period>("3M");
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const [focusedIdx, setFocusedIdx] = useState(-1);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

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
      {/* Search header */}
      <div className="shrink-0 border-b border-border/40 bg-background/95 backdrop-blur px-6 py-3 z-10">
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
      </div>

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
                  <h1 className="text-2xl font-bold font-mono tracking-tight shrink-0">
                    {m.ticker}
                  </h1>
                  <span className="text-base text-muted-foreground font-medium truncate">
                    {m.companyName}
                  </span>
                </div>
                <div className="flex flex-wrap items-center gap-1.5 mt-1.5">
                  {m.exchange && (
                    <span className="text-[10px] bg-secondary/60 border border-border/40 px-2 py-0.5 rounded-md font-mono">
                      {m.exchange}
                    </span>
                  )}
                  {m.sector && (
                    <span className="text-[10px] text-muted-foreground">{m.sector}</span>
                  )}
                  {m.industry && (
                    <>
                      <span className="text-[10px] text-muted-foreground/40">·</span>
                      <span className="text-[10px] text-muted-foreground">{m.industry}</span>
                    </>
                  )}
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
                <div className="text-[11px] text-muted-foreground mt-0.5">
                  Mkt Cap: {formatLargeNumber(m.marketCap)}
                </div>
              </div>
            </div>

            {/* ── Snowflake + Overview ── */}
            <div className="grid grid-cols-[240px_1fr] gap-4">
              {/* Snowflake */}
              <div className="bg-card border border-border/50 rounded-xl p-4 flex flex-col">
                <span className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground text-center mb-1">
                  Investment Profile
                </span>
                <SnowflakeChart scores={data.snowflake} />
                <div className="grid grid-cols-2 gap-1.5 mt-1">
                  {(
                    [
                      { label: "Value", key: "value" },
                      { label: "Future Growth", key: "growth" },
                      { label: "Past Perf.", key: "past" },
                      { label: "Health", key: "health" },
                      { label: "Dividend", key: "dividend" },
                    ] as const
                  ).map(({ label, key }) => (
                    <div
                      key={key}
                      className="flex items-center justify-between bg-secondary/30 rounded-md px-2 py-1"
                    >
                      <span className="text-[10px] text-muted-foreground">{label}</span>
                      <ScoreBadge score={data.snowflake[key]} />
                    </div>
                  ))}
                </div>
              </div>

              {/* Overview + 52W range */}
              <div className="flex flex-col gap-3">
                <div className="bg-card border border-border/50 rounded-xl p-4 flex-1">
                  <span className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground">
                    Company Overview
                  </span>
                  <p className="text-xs text-muted-foreground leading-relaxed mt-2 line-clamp-5">
                    {m.description || "No description available."}
                  </p>
                  <div className="grid grid-cols-3 gap-2 mt-3 pt-3 border-t border-border/30">
                    {[
                      { label: "Stock Type", value: m.stockType },
                      { label: "Beta", value: formatNumber(m.beta) },
                      {
                        label: "Fair Value Est.",
                        value: m.fairValueEstimate ? formatCurrency(m.fairValueEstimate) : "—",
                      },
                    ].map(({ label, value }) => (
                      <div key={label}>
                        <div className="text-[9px] text-muted-foreground/60 uppercase tracking-wider">
                          {label}
                        </div>
                        <div className="text-xs font-semibold mt-0.5">{value}</div>
                      </div>
                    ))}
                  </div>
                </div>

                {m.currentPrice != null &&
                  m.fiftyTwoWeekLow != null &&
                  m.fiftyTwoWeekHigh != null && (
                    <div className="bg-card border border-border/50 rounded-xl p-4">
                      <span className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground">
                        52-Week Range
                      </span>
                      <div className="mt-3">
                        <RangeBar
                          current={m.currentPrice}
                          low={m.fiftyTwoWeekLow}
                          high={m.fiftyTwoWeekHigh}
                        />
                      </div>
                    </div>
                  )}
              </div>
            </div>

            {/* ── Price Chart ── */}
            <div className="overflow-hidden">
              <PriceChart
                tickers={[m.ticker]}
                loadedStocks={[m]}
                selectedPeriod={chartPeriod}
                onPeriodChange={setChartPeriod}
              />
            </div>

            {/* ── Metrics grid ── */}
            <div className="grid grid-cols-2 gap-4">
              {/* Valuation */}
              <SectionCard title="Valuation" score={data.snowflake.value}>
                <MetricRow label="P/E Ratio" value={formatNumber(m.peRatio)} />
                <MetricRow label="PEG Ratio" value={formatNumber(m.pegRatio)} good={m.pegRatio != null ? m.pegRatio < 1.5 : undefined} />
                <MetricRow label="Price / Book" value={formatNumber(m.priceToBook)} />
                <MetricRow label="Price / Sales" value={formatNumber(m.priceToSales)} />
                {m.analystTargetPrice != null && (
                  <MetricRow
                    label="Analyst Target"
                    value={formatCurrency(m.analystTargetPrice)}
                  />
                )}
                {m.analystTargetPrice != null && m.currentPrice != null && (
                  <MetricRow
                    label="Upside to Target"
                    value={`${((m.analystTargetPrice / m.currentPrice - 1) * 100).toFixed(1)}%`}
                    good={m.analystTargetPrice > m.currentPrice}
                  />
                )}
                {m.fairValueEstimate != null && m.currentPrice != null && (
                  <MetricRow
                    label="Fair Value Est."
                    value={formatCurrency(m.fairValueEstimate)}
                    good={m.fairValueEstimate > m.currentPrice}
                  />
                )}
              </SectionCard>

              {/* Future Growth */}
              <SectionCard title="Future Growth" score={data.snowflake.growth}>
                <MetricRow
                  label="Revenue Growth (YoY)"
                  value={formatPercent(m.revenueGrowthYoY)}
                  good={m.revenueGrowthYoY != null ? m.revenueGrowthYoY > 0 : undefined}
                />
                <MetricRow
                  label="EPS Growth"
                  value={formatPercent(m.epsGrowth)}
                  good={m.epsGrowth != null ? m.epsGrowth > 0 : undefined}
                />
                <MetricRow label="EPS (Trailing)" value={formatCurrency(m.earningsPerShare)} />
                <MetricRow label="Total Revenue" value={formatLargeNumber(m.totalRevenue)} />
                <MetricRow label="EBITDA" value={formatLargeNumber(m.ebitda)} />
              </SectionCard>

              {/* Past Performance */}
              <SectionCard title="Past Performance" score={data.snowflake.past}>
                <MetricRow
                  label="Return on Equity"
                  value={formatPercent(m.returnOnEquity)}
                  good={m.returnOnEquity != null ? m.returnOnEquity > 0.1 : undefined}
                />
                <MetricRow
                  label="Return on Assets"
                  value={formatPercent(m.returnOnAssets)}
                  good={m.returnOnAssets != null ? m.returnOnAssets > 0 : undefined}
                />
                <MetricRow label="Gross Margin" value={formatPercent(m.grossMargin)} />
                <MetricRow label="Operating Margin" value={formatPercent(m.operatingMargin)} />
                <MetricRow
                  label="Net Margin"
                  value={formatPercent(m.netMargin)}
                  good={m.netMargin != null ? m.netMargin > 0.08 : undefined}
                />
                <MetricRow label="Free Cash Flow" value={formatLargeNumber(m.freeCashFlow)} />
              </SectionCard>

              {/* Financial Health */}
              <SectionCard title="Financial Health" score={data.snowflake.health}>
                <MetricRow
                  label="Current Ratio"
                  value={formatNumber(m.currentRatio)}
                  good={m.currentRatio != null ? m.currentRatio > 1.5 : undefined}
                />
                <MetricRow
                  label="Debt / Equity"
                  value={formatNumber(m.debtToEquity)}
                  good={m.debtToEquity != null ? m.debtToEquity < 0.5 : undefined}
                />
                <MetricRow label="Net Income" value={formatLargeNumber(m.netIncome)} />
                <MetricRow
                  label="Dividend Yield"
                  value={formatPercent(m.dividendYield)}
                  good={m.dividendYield != null && m.dividendYield > 0 ? true : undefined}
                />
              </SectionCard>
            </div>

            {/* ── Analyst Ratings ── */}
            {data.recommendations && (
              <div className="bg-card border border-border/50 rounded-xl p-4">
                <span className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground block mb-4">
                  Analyst Ratings
                </span>
                <div className="flex flex-col sm:flex-row items-start sm:items-center gap-6">
                  <AnalystDonut recs={data.recommendations} />
                  {m.analystTargetPrice != null && m.currentPrice != null && (
                    <div className="flex-1 border-t sm:border-t-0 sm:border-l border-border/40 pt-4 sm:pt-0 sm:pl-6">
                      <div className="text-[10px] text-muted-foreground uppercase tracking-widest mb-3">
                        Consensus Price Target
                      </div>
                      <div className="flex items-end gap-3">
                        <div>
                          <div className="text-[10px] text-muted-foreground mb-1">Current</div>
                          <div className="text-xl font-bold font-mono">${m.currentPrice.toFixed(2)}</div>
                        </div>
                        <div className="text-muted-foreground/40 text-lg mb-1">→</div>
                        <div>
                          <div className="text-[10px] text-muted-foreground mb-1">12M Target</div>
                          <div className="text-xl font-bold font-mono">${m.analystTargetPrice.toFixed(2)}</div>
                        </div>
                        <div
                          className={cn(
                            "text-base font-bold font-mono mb-0.5",
                            m.analystTargetPrice > m.currentPrice ? "text-green-400" : "text-red-400",
                          )}
                        >
                          {((m.analystTargetPrice / m.currentPrice - 1) * 100) >= 0 ? "+" : ""}
                          {((m.analystTargetPrice / m.currentPrice - 1) * 100).toFixed(1)}%
                        </div>
                      </div>
                    </div>
                  )}
                </div>
              </div>
            )}

            {/* ── Recent News ── */}
            {data.news && data.news.length > 0 && (
              <div className="bg-card border border-border/50 rounded-xl p-4">
                <span className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground block mb-2">
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
