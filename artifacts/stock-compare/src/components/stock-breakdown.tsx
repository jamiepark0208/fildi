import { useState, useRef, useCallback, useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { useLocation } from "wouter";
import {
  Loader2, Search, AlertCircle, BarChart2, TrendingUp, TrendingDown, LineChart
} from "lucide-react";
import { PriceChart, Period } from "./price-chart";
import { CompetitorsSection } from "./competitors-section";
import { CatalystsSection } from "./catalysts-section";
import { AnalystRatingsSection, type Recommendations, type AnalystAction, type AnalystPriceTarget, type PriceTargetRange } from "./analyst-ratings-section";
import { MarketSentimentSection } from "./market-sentiment-section";
import { NewsCard, type NewsItem } from "./news-card";
import { BreakdownMetricsTable } from "./breakdown-metrics-table";
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
            <BreakdownMetricsTable
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
