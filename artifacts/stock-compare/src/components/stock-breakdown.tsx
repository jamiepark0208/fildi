import { useState, useRef, useCallback, useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { useLocation } from "wouter";
import {
  Loader2, Search, AlertCircle, BarChart2, TrendingUp, TrendingDown, LineChart, Minus, Plus
} from "lucide-react";
import { PriceChart, Period } from "./price-chart";
import { TradingViewTechnicalWidget } from "./tradingview-technical-widget";
import { CompetitorsSection } from "./competitors-section";
import { CatalystsSection } from "./catalysts-section";
import { AnalystRatingsSection, type Recommendations, type AnalystAction, type AnalystPriceTarget, type PriceTargetRange } from "./analyst-ratings-section";
import { MarketSentimentSection } from "./market-sentiment-section";
import { AccountingStatementsSection } from "./accounting-statements-section";
import { NewsCard, type NewsItem } from "./news-card";
import { BreakdownMetricsTable } from "./breakdown-metrics-table";
import { TabBar, type TabBarItem } from "./ui/tab-bar";
import { useSearchStocks, getSearchStocksQueryKey } from "@workspace/api-client-react";
import { useDebounce } from "@/hooks/use-debounce";
import { cn } from "@/lib/utils";
import { formatCurrency, formatLargeNumber, formatNumber, formatPercent } from "@/lib/format";
import { addToScannerShelf } from "@/lib/ticker-shelf-storage";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { Popover, PopoverTrigger, PopoverContent } from "@/components/ui/popover";

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

// ── Classification tags (exchange/sector/industry/stockType) ───────────────────
// Each tag type gets its own color so the row reads as distinct categories rather
// than a wall of grey text. Clicking a tag opens a popup listing other watchlist
// tickers sharing that same value.

type ClassificationTagType = "exchange" | "sector" | "industry" | "stockType";
type TagType = ClassificationTagType | "beta" | "fairValue" | "marketCap";

interface WatchlistTagEntry {
  companyName?: string | null;
  exchange?: string | null;
  sector?: string | null;
  industry?: string | null;
  stockType?: string | null;
}

const TAG_STYLES: Record<TagType, string> = {
  exchange:  "border-sky-500/30 bg-sky-500/10 text-sky-300 hover:bg-sky-500/20",
  sector:    "border-violet-500/30 bg-violet-500/10 text-violet-300 hover:bg-violet-500/20",
  industry:  "border-teal-500/30 bg-teal-500/10 text-teal-300 hover:bg-teal-500/20",
  stockType: "border-amber-500/30 bg-amber-500/10 text-amber-300 hover:bg-amber-500/20",
  beta:      "border-rose-500/30 bg-rose-500/10 text-rose-300 hover:bg-rose-500/20",
  fairValue: "border-emerald-500/30 bg-emerald-500/10 text-emerald-300 hover:bg-emerald-500/20",
  marketCap: "border-blue-500/30 bg-blue-500/10 text-blue-300 hover:bg-blue-500/20",
};

function TagBadge({
  type, value, matches, onSelectTicker,
}: {
  type: TagType; value: string;
  matches?: { ticker: string; companyName: string | null }[];
  onSelectTicker?: (t: string) => void;
}) {
  const badgeClass = cn(
    "text-[10px] font-semibold tracking-wide px-2 py-0.5 rounded-full border transition-colors",
    matches ? "cursor-pointer" : "cursor-default",
    TAG_STYLES[type],
  );

  if (!matches) {
    return <button type="button" disabled className={badgeClass}>{value}</button>;
  }

  // Styled to match the Live Monitor intraday regime checkpoint popover (live.tsx).
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button type="button" className={cn(badgeClass, "hover:brightness-125")}>{value}</button>
      </PopoverTrigger>
      <PopoverContent className="w-64 p-0 text-xs bg-zinc-900 border-zinc-600/40" align="start">
        <div className="px-3 py-2 border-b border-amber-500/20 bg-zinc-800/90 flex items-center gap-2">
          <span className={cn("text-[10px] font-semibold tracking-wide px-2 py-0.5 rounded-full border shrink-0", TAG_STYLES[type])}>
            {value}
          </span>
          <span className="text-zinc-400 text-[11px]">
            {matches.length} ticker{matches.length !== 1 ? "s" : ""} in your watchlist
          </span>
        </div>
        <div className="p-2 flex flex-col gap-0.5 max-h-72 overflow-y-auto">
          {matches.length === 0 ? (
            <span className="text-zinc-500 italic px-1.5 py-1">No other watchlist tickers share this tag.</span>
          ) : (
            matches.map(({ ticker: t, companyName }) => (
              <button
                key={t}
                onClick={() => onSelectTicker?.(t)}
                className="w-full flex items-center justify-between gap-2 px-2 py-1.5 rounded-md hover:bg-zinc-800 transition-colors text-left"
              >
                <span className="font-mono font-bold text-xs text-white">{t}</span>
                {companyName && <span className="text-[11px] text-zinc-400 truncate">{companyName}</span>}
              </button>
            ))
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}

type BreakdownTab = "analyst" | "sentiment" | "catalysts" | "news" | "accounting";

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

export function StockBreakdown({
  ticker: propTicker,
  watchlistMetrics,
}: { ticker?: string; watchlistMetrics?: Record<string, WatchlistTagEntry | undefined> } = {}) {
  const [, navigate] = useLocation();
  const [inputText, setInputText] = useState(propTicker ?? "");
  const [activeTicker, setActiveTicker] = useState<string | null>(propTicker ?? null);
  const [chartPeriod, setChartPeriod] = useState<Period>("1W");
  const [breakdownTab, setBreakdownTab] = useState<BreakdownTab>("analyst");

  // Technical widget / Peers box split — user-draggable, persisted per browser.
  const SIDE_PANEL_TOTAL = 360; // matches the h-[360px] row height below
  const SIDE_PANEL_MIN = 60;
  const [techBoxHeight, setTechBoxHeight] = useState<number>(() => {
    const saved = Math.round(Number(localStorage.getItem("breakdown-tech-box-height")));
    return saved >= SIDE_PANEL_MIN && saved <= SIDE_PANEL_TOTAL - SIDE_PANEL_MIN ? saved : 240;
  });
  const [dragHeight, setDragHeight] = useState<number | null>(null);
  const dragStartRef = useRef<{ y: number; height: number } | null>(null);
  const [techZoom, setTechZoom] = useState<number>(() => {
    const saved = Number(localStorage.getItem("breakdown-tech-widget-zoom"));
    return saved >= 0.5 && saved <= 2 ? saved : 1;
  });
  useEffect(() => {
    localStorage.setItem("breakdown-tech-widget-zoom", String(techZoom));
  }, [techZoom]);

  const handleSplitPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    dragStartRef.current = { y: e.clientY, height: techBoxHeight };
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
  };
  const handleSplitPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!dragStartRef.current) return;
    const delta = Math.round(e.clientY - dragStartRef.current.y);
    const next = Math.min(
      SIDE_PANEL_TOTAL - SIDE_PANEL_MIN,
      Math.max(SIDE_PANEL_MIN, dragStartRef.current.height + delta),
    );
    setDragHeight(next);
  };
  const handleSplitPointerUp = () => {
    if (!dragStartRef.current) return;
    if (dragHeight != null) {
      setTechBoxHeight(dragHeight);
      localStorage.setItem("breakdown-tech-box-height", String(dragHeight));
    }
    dragStartRef.current = null;
    setDragHeight(null);
  };
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const [focusedIdx, setFocusedIdx] = useState(-1);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // When driven by watchlist click, sync ticker from prop
  useEffect(() => {
    if (propTicker) {
      setActiveTicker(propTicker);
      setInputText(propTicker);
      setChartPeriod("1W");
      setBreakdownTab("analyst");
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

  const tagMatchesFor = useCallback((type: ClassificationTagType, value: string) => {
    if (!watchlistMetrics) return undefined;
    return Object.entries(watchlistMetrics)
      .filter(([, m]) => m?.[type] === value)
      .map(([t, m]) => ({ ticker: t, companyName: m?.companyName ?? null }))
      .sort((a, b) => a.ticker.localeCompare(b.ticker));
  }, [watchlistMetrics]);

  const commitTicker = useCallback((t: string) => {
    const upper = t.trim().toUpperCase();
    if (!upper) return;
    setActiveTicker(upper);
    setInputText(upper);
    setDropdownOpen(false);
    setFocusedIdx(-1);
    setChartPeriod("1W");
    setBreakdownTab("analyst");
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
      {!propTicker && <div className="shrink-0 border-b border-[#d4af37]/20 bg-zinc-900/95 backdrop-blur px-6 py-3 z-10">
        <div className="max-w-5xl mx-auto flex gap-2">
          <div className="relative flex-1">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-500 pointer-events-none z-10" />
            {isSearching && debouncedQuery.length >= 1 && (
              <Loader2 className="absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-500 animate-spin z-10" />
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
              className="w-full h-10 pl-9 pr-9 text-sm font-mono bg-white border border-white/20 text-black placeholder:text-gray-500 rounded-lg focus:outline-none focus:ring-2 focus:ring-primary transition-colors"
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
          <div className="max-w-5xl mx-auto px-6 pt-8">
            <div className="flex items-start gap-3 bg-red-500/10 border border-red-500/20 text-red-400 rounded-xl p-4">
              <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
              <span className="text-sm">{error.message}</span>
            </div>
          </div>
        )}

        {/* Main content */}
        {m && !isLoading && (
          <div className="max-w-5xl mx-auto px-5 py-4 space-y-3 pb-8">
            {/* ── Header ── */}
            <div className="flex items-start justify-between gap-4">
              <div className="min-w-0 flex-1">
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
              </div>

              <button
                type="button"
                onClick={() => { addToScannerShelf(m.ticker); navigate("/options-scanner"); }}
                className="flex items-center gap-1 text-[11px] font-medium text-white bg-green-600 hover:bg-green-500 rounded-md px-2.5 py-1 transition-colors shrink-0"
              >
                <LineChart className="w-3 h-3" /> Open Options
              </button>

              <div className="text-right shrink-0">
                <div className="flex items-baseline justify-end gap-2">
                  <span className="text-2xl font-bold font-mono tracking-tight">
                    {m.currentPrice != null ? `$${m.currentPrice.toFixed(2)}` : "—"}
                  </span>
                  <span
                    className={cn(
                      "flex items-center gap-1 text-sm font-mono font-semibold",
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
                  </span>
                </div>
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-1.5 mt-1.5">
              {m.exchange && (
                <TagBadge type="exchange" value={m.exchange} matches={tagMatchesFor("exchange", m.exchange)} onSelectTicker={commitTicker} />
              )}
              {m.sector && (
                <TagBadge type="sector" value={m.sector} matches={tagMatchesFor("sector", m.sector)} onSelectTicker={commitTicker} />
              )}
              {m.industry && (
                <TagBadge type="industry" value={m.industry} matches={tagMatchesFor("industry", m.industry)} onSelectTicker={commitTicker} />
              )}
              {m.stockType && (
                <TagBadge type="stockType" value={m.stockType} matches={tagMatchesFor("stockType", m.stockType)} onSelectTicker={commitTicker} />
              )}
              {m.beta != null && (
                <TagBadge type="beta" value={`Beta ${formatNumber(m.beta)}`} />
              )}
              {m.fairValueEstimate != null && (
                <TagBadge type="fairValue" value={`Fair Value ${formatCurrency(m.fairValueEstimate)}`} />
              )}
              {m.marketCap != null && (
                <TagBadge type="marketCap" value={`Mkt Cap ${formatLargeNumber(m.marketCap)}`} />
              )}
            </div>

            {/* ── Top reward / risk summary ── */}
            {(data.bullBullets?.[0] || data.bearBullets?.[0]) && (
              <div className="grid grid-cols-2 gap-3 mt-0.5">
                {data.bullBullets?.[0] && (
                  <div className="flex gap-2 text-[12px] text-muted-foreground leading-relaxed border-l-2 border-green-500/50 pl-2.5 py-1">
                    <span className="shrink-0 text-green-500/70 mt-0.5">▲</span>
                    {data.bullBullets[0]}
                  </div>
                )}
                {data.bearBullets?.[0] && (
                  <div className="flex gap-2 text-[12px] text-muted-foreground leading-relaxed border-l-2 border-red-500/50 pl-2.5 py-1">
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

            {/* ── Price Chart + Technical / Peers side boxes ── */}
            {(() => {
              const hasPeers = !!propTicker && !!activeTicker;
              return (
                <div className="grid grid-cols-4 gap-2 h-[360px] w-full">
                  <div className="col-span-3 h-full min-w-0">
                    <PriceChart
                      tickers={[m.ticker]}
                      loadedStocks={[m]}
                      selectedPeriod={chartPeriod}
                      onPeriodChange={setChartPeriod}
                      showTechnicalZones={!!propTicker}
                      tickerForTechnicals={propTicker}
                      compact
                    />
                  </div>
                  <div className="col-span-1 h-full min-w-0 flex flex-col min-h-0">
                    <div
                      className="relative bg-zinc-950 border border-[#d4af37]/20 rounded-lg p-2 shrink-0 min-w-0 overflow-hidden flex items-center justify-center group/tech"
                      style={{ height: dragHeight ?? techBoxHeight }}
                    >
                      <div style={{ zoom: techZoom }}>
                        <TradingViewTechnicalWidget ticker={m.ticker} exchange={m.exchange} height={Math.round(Math.max(60, techBoxHeight - 16))} />
                      </div>
                      <div className="absolute top-1 right-1 flex items-center gap-0.5 opacity-0 group-hover/tech:opacity-100 transition-opacity">
                        <button
                          type="button"
                          onClick={() => setTechZoom(z => Math.max(0.5, Math.round((z - 0.1) * 10) / 10))}
                          className="w-4 h-4 flex items-center justify-center rounded bg-zinc-900/90 border border-[#d4af37]/30 text-[#d4af37]/70 hover:text-[#d4af37] hover:border-[#d4af37]/60 text-[10px] leading-none"
                          title="Shrink widget"
                        >
                          <Minus className="w-2.5 h-2.5" />
                        </button>
                        <button
                          type="button"
                          onClick={() => setTechZoom(z => Math.min(2, Math.round((z + 0.1) * 10) / 10))}
                          className="w-4 h-4 flex items-center justify-center rounded bg-zinc-900/90 border border-[#d4af37]/30 text-[#d4af37]/70 hover:text-[#d4af37] hover:border-[#d4af37]/60 text-[10px] leading-none"
                          title="Enlarge widget"
                        >
                          <Plus className="w-2.5 h-2.5" />
                        </button>
                      </div>
                    </div>
                    <div
                      onPointerDown={handleSplitPointerDown}
                      onPointerMove={handleSplitPointerMove}
                      onPointerUp={handleSplitPointerUp}
                      className="h-2 shrink-0 -my-px cursor-row-resize flex items-center justify-center touch-none select-none group"
                      title="Drag to resize"
                    >
                      <div className="w-8 h-1 rounded-full bg-[#d4af37]/25 group-hover:bg-[#d4af37]/60 group-active:bg-[#d4af37] transition-colors" />
                    </div>
                    <div className="bg-zinc-950 border border-[#d4af37]/20 rounded-lg p-2 flex-1 min-h-0 min-w-0 overflow-hidden">
                      {hasPeers ? (
                        <CompetitorsSection ticker={activeTicker!} />
                      ) : (
                        <>
                          <div className="text-[11px] font-bold tracking-tight text-[#d4af37] mb-1">Peers</div>
                          <span className="text-[10px] text-amber-200/50 italic">No peer data available.</span>
                        </>
                      )}
                    </div>
                  </div>
                </div>
              );
            })()}

            {/* ── Below-chart detail tabs: Analyst / Sentiment / Catalysts / Accounting / News ── */}
            {(() => {
              const hasSentiment = data.bullBullets?.length > 0 || data.bearBullets?.length > 0 || !!data.recommendations;
              const hasNews = !!data.news && data.news.length > 0;
              const tabs: TabBarItem<BreakdownTab>[] = [
                ...(data.recommendations ? [{ id: "analyst" as const, label: "Analyst Ratings", color: "violet" as const }] : []),
                ...(hasSentiment ? [{ id: "sentiment" as const, label: "Sentiment", color: "emerald" as const }] : []),
                { id: "catalysts" as const, label: "Catalysts", color: "amber" as const },
                { id: "accounting" as const, label: "Accounting", color: "teal" as const },
                ...(hasNews ? [{ id: "news" as const, label: "News", color: "rose" as const }] : []),
              ];
              const activeTab: BreakdownTab = tabs.some(t => t.id === breakdownTab) ? breakdownTab : "analyst";

              return (
                <div className="bg-zinc-950 border border-[#d4af37]/20 rounded-xl overflow-hidden">
                  <div className="px-4 pt-3 pb-2 border-b border-[#d4af37]/20 bg-black">
                    <TabBar tabs={tabs} active={activeTab} onChange={(id) => setBreakdownTab(id)} />
                  </div>
                  <div className="p-4">
                    {activeTab === "analyst" && data.recommendations && (
                      <AnalystRatingsSection
                        recs={data.recommendations}
                        metrics={m}
                        analystActions={data.analystActions ?? []}
                        analystPriceTargets={data.analystPriceTargets ?? []}
                        priceTargetRange={data.priceTargetRange ?? null}
                      />
                    )}
                    {activeTab === "sentiment" && (
                      <MarketSentimentSection
                        recs={data.recommendations}
                        bullBullets={data.bullBullets ?? []}
                        bearBullets={data.bearBullets ?? []}
                      />
                    )}
                    {activeTab === "catalysts" && <CatalystsSection catalysts={data.catalysts} />}
                    {activeTab === "accounting" && <AccountingStatementsSection ticker={m.ticker} />}
                    {activeTab === "news" && hasNews && (
                      <div className="space-y-0.5 -mx-1">
                        {data.news.map((item, i) => (
                          <NewsCard key={i} item={item} />
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              );
            })()}
          </div>
        )}
      </div>

    </div>
  );
}
