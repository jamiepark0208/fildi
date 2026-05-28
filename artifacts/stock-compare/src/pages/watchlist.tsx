import { useState, useRef, useMemo, useCallback } from "react";
import { Sidebar } from "@/components/sidebar";
import { useWatchlist, PRESET_COLORS } from "@/hooks/use-watchlist";
import { useQueries } from "@tanstack/react-query";
import {
  getGetStockQuoteQueryOptions,
  getGetStockQuoteQueryKey,
  getGetStockHistoryQueryKey,
  useGetStockQuote,
  useGetStockHistory,
  useSearchStocks,
  getSearchStocksQueryKey,
  StockMetrics
} from "@workspace/api-client-react";
import { PriceChart, Period } from "@/components/price-chart";
import { Search, Loader2, X, BarChart2, Plus } from "lucide-react";
import { useDebounce } from "@/hooks/use-debounce";
import { cn } from "@/lib/utils";
import { formatCurrency, formatLargeNumber, formatNumber } from "@/lib/format";

function PerformancePill({ data, label }: { data?: any[], label: string }) {
  if (!data || data.length < 2) {
    return (
      <div className="flex items-center gap-1.5 bg-secondary/30 px-2 py-1 rounded text-xs">
        <span className="text-muted-foreground font-medium">{label}</span>
        <span className="text-muted-foreground">—</span>
      </div>
    );
  }
  
  const firstClose = data[0].close;
  const lastClose = data[data.length - 1].close;
  const changePct = ((lastClose - firstClose) / firstClose) * 100;
  
  const isPositive = changePct >= 0;
  const colorClass = isPositive ? "text-green-500" : "text-red-500";
  const sign = isPositive ? "+" : "";

  return (
    <div className="flex items-center gap-1.5 bg-secondary/30 px-2 py-1 rounded text-xs font-mono">
      <span className="text-muted-foreground font-sans font-medium">{label}</span>
      <span className={colorClass}>{sign}{changePct.toFixed(2)}%</span>
    </div>
  );
}

export default function Watchlist() {
  const { entries, isLoaded, addEntry, removeEntry, updateColorTag } = useWatchlist();
  const [selectedTicker, setSelectedTicker] = useState<string | null>(null);
  const [filterColor, setFilterColor] = useState<string | null>(null);

  // Search state
  const [inputText, setInputText] = useState("");
  const [open, setOpen] = useState(false);
  const [focusedIndex, setFocusedIndex] = useState(-1);
  const [showColorPicker, setShowColorPicker] = useState<string | null>(null); // ticker to add
  
  const inputRef = useRef<HTMLInputElement>(null);
  const closeTimeout = useRef<ReturnType<typeof setTimeout> | null>(null);
  
  const debouncedSearch = useDebounce(inputText, 180);

  const { data: searchResults, isFetching: isSearching } = useSearchStocks(
    { q: debouncedSearch },
    {
      query: {
        enabled: debouncedSearch.length >= 2,
        queryKey: getSearchStocksQueryKey({ q: debouncedSearch }),
        staleTime: 5 * 60 * 1000,
      },
    }
  );

  const visibleResults = open && (searchResults?.length ?? 0) > 0 ? searchResults! : [];

  const selectTickerForAdd = useCallback((ticker: string) => {
    const upper = ticker.toUpperCase();
    setShowColorPicker(upper);
    setInputText("");
    setOpen(false);
    setFocusedIndex(-1);
    inputRef.current?.blur();
  }, []);

  const confirmAdd = (color: string) => {
    if (showColorPicker) {
      addEntry(showColorPicker, color);
      setShowColorPicker(null);
    }
  };

  const handleSearchChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setInputText(e.target.value.toUpperCase());
    setOpen(true);
    setFocusedIndex(-1);
  };

  const handleSearchFocus = () => {
    if (closeTimeout.current) clearTimeout(closeTimeout.current);
    if (inputText.length >= 2) setOpen(true);
  };

  const handleSearchBlur = () => {
    closeTimeout.current = setTimeout(() => setOpen(false), 150);
  };

  const handleSearchKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (!open || visibleResults.length === 0) {
      if (e.key === "Enter" && inputText.trim()) {
        e.preventDefault();
        selectTickerForAdd(inputText.trim());
      }
      return;
    }
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setFocusedIndex(i => Math.min(i + 1, visibleResults.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setFocusedIndex(i => Math.max(i - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (focusedIndex >= 0 && visibleResults[focusedIndex]) {
        selectTickerForAdd(visibleResults[focusedIndex].ticker);
      } else if (inputText.trim()) {
        selectTickerForAdd(inputText.trim());
      } else {
        setOpen(false);
      }
    } else if (e.key === "Escape") {
      setOpen(false);
    }
  };

  // Watchlist table queries
  const visibleEntries = useMemo(() => {
    if (!filterColor) return entries;
    return entries.filter(e => e.colorTag === filterColor);
  }, [entries, filterColor]);

  const listQueries = useQueries({
    queries: visibleEntries.map((entry) => ({
      ...getGetStockQuoteQueryOptions({ ticker: entry.ticker }),
      staleTime: 60 * 1000,
    })),
  });

  const usedColors = useMemo(() => {
    const colors = new Set<string>();
    entries.forEach(e => { if (e.colorTag) colors.add(e.colorTag); });
    return Array.from(colors);
  }, [entries]);

  // Detail panel queries
  const { data: detailQuote } = useGetStockQuote(
    { ticker: selectedTicker || "" },
    { query: { enabled: !!selectedTicker, staleTime: 60 * 1000, queryKey: getGetStockQuoteQueryKey({ ticker: selectedTicker || "" }) } }
  );

  const { data: history1W } = useGetStockHistory(
    { ticker: selectedTicker || "", period: "1W" },
    { query: { enabled: !!selectedTicker, staleTime: 5 * 60 * 1000, queryKey: getGetStockHistoryQueryKey({ ticker: selectedTicker || "", period: "1W" }) } }
  );
  const { data: history1M } = useGetStockHistory(
    { ticker: selectedTicker || "", period: "1M" },
    { query: { enabled: !!selectedTicker, staleTime: 5 * 60 * 1000, queryKey: getGetStockHistoryQueryKey({ ticker: selectedTicker || "", period: "1M" }) } }
  );
  const { data: history3M } = useGetStockHistory(
    { ticker: selectedTicker || "", period: "3M" },
    { query: { enabled: !!selectedTicker, staleTime: 5 * 60 * 1000, queryKey: getGetStockHistoryQueryKey({ ticker: selectedTicker || "", period: "3M" }) } }
  );

  const [chartPeriod, setChartPeriod] = useState<Period>("1M");
  const [descExpanded, setDescExpanded] = useState(false);

  if (!isLoaded) return null;

  return (
    <div className="min-h-[100dvh] bg-background text-foreground flex">
      <Sidebar />
      <main className="flex-1 ml-[220px] flex h-[100dvh] overflow-hidden">
        
        {/* Left Panel */}
        <div className="w-[300px] border-r border-border flex flex-col shrink-0 bg-sidebar/30">
          
          {/* Search Header */}
          <div className="p-4 border-b border-border/40">
            {showColorPicker ? (
              <div className="bg-card border border-border rounded-md p-3 shadow-sm">
                <div className="text-xs font-medium mb-2">Tag for {showColorPicker}</div>
                <div className="flex flex-wrap gap-2 mb-3">
                  {PRESET_COLORS.map(c => (
                    <button
                      key={c}
                      onClick={() => confirmAdd(c)}
                      className="w-5 h-5 rounded-full hover:scale-110 transition-transform"
                      style={{ backgroundColor: c }}
                    />
                  ))}
                  <button
                    onClick={() => confirmAdd("")}
                    className="w-5 h-5 rounded-full border border-dashed border-muted-foreground flex items-center justify-center hover:scale-110 transition-transform bg-transparent"
                    title="No tag"
                  />
                </div>
                <button 
                  onClick={() => setShowColorPicker(null)}
                  className="text-xs text-muted-foreground hover:text-foreground"
                >
                  Cancel
                </button>
              </div>
            ) : (
              <div className="relative">
                <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground z-10" />
                {isSearching && debouncedSearch.length >= 2 && (
                  <Loader2 className="absolute right-2.5 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground animate-spin z-10" />
                )}
                <input
                  ref={inputRef}
                  type="text"
                  autoComplete="off"
                  value={inputText}
                  onChange={handleSearchChange}
                  onFocus={handleSearchFocus}
                  onBlur={handleSearchBlur}
                  onKeyDown={handleSearchKeyDown}
                  placeholder="Search to add..."
                  className="w-full h-9 pl-9 pr-8 text-sm bg-background border border-border rounded-md focus:outline-none focus:ring-1 focus:ring-primary focus:border-primary transition-colors"
                />
                
                {open && debouncedSearch.length >= 2 && (
                  <div className="absolute top-full left-0 right-0 mt-1 z-50 bg-card border border-border rounded-md shadow-xl overflow-hidden max-h-60 overflow-y-auto">
                    {isSearching && (!searchResults || searchResults.length === 0) ? (
                      <div className="px-3 py-2 text-xs text-muted-foreground">Searching...</div>
                    ) : visibleResults.length === 0 ? (
                      <div className="px-3 py-2 text-xs text-muted-foreground">No results found</div>
                    ) : (
                      <ul className="py-1">
                        {visibleResults.map((r, i) => (
                          <li
                            key={r.ticker}
                            onMouseDown={(e) => {
                              e.preventDefault();
                              selectTickerForAdd(r.ticker);
                            }}
                            className={cn(
                              "px-3 py-2 text-sm cursor-pointer flex items-center justify-between hover:bg-primary/10",
                              i === focusedIndex && "bg-primary/10"
                            )}
                          >
                            <span className="font-mono font-bold">{r.ticker}</span>
                            <span className="text-muted-foreground text-xs truncate ml-2 max-w-[150px]">{r.name}</span>
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                )}
              </div>
            )}

            {/* Filter Chips */}
            <div className="mt-3 flex items-center gap-1.5 overflow-x-auto pb-1 scrollbar-none">
              <button
                onClick={() => setFilterColor(null)}
                className={cn(
                  "text-[10px] px-2 py-0.5 rounded-full font-medium transition-colors border",
                  !filterColor ? "bg-primary/20 text-primary border-primary/30" : "bg-transparent text-muted-foreground border-transparent hover:bg-secondary"
                )}
              >
                All
              </button>
              {usedColors.map(c => (
                <button
                  key={c}
                  onClick={() => setFilterColor(filterColor === c ? null : c)}
                  className={cn(
                    "w-4 h-4 rounded-full flex-shrink-0 transition-transform border border-transparent",
                    filterColor === c && "ring-2 ring-primary ring-offset-1 ring-offset-background"
                  )}
                  style={{ backgroundColor: c }}
                />
              ))}
            </div>
          </div>

          {/* Table Header */}
          <div className="grid grid-cols-[16px_1fr_1fr_1fr_1fr] items-center px-4 py-2 border-b border-border/40 text-[10px] font-semibold text-muted-foreground uppercase tracking-wider sticky top-0 bg-sidebar/30 backdrop-blur-md z-10">
            <div />
            <div>Symbol</div>
            <div className="text-right">Last</div>
            <div className="text-right">Chg</div>
            <div className="text-right">Chg%</div>
          </div>

          {/* Table Body */}
          <div className="flex-1 overflow-y-auto">
            {visibleEntries.length === 0 ? (
              <div className="p-8 text-center text-xs text-muted-foreground">
                No tickers in watchlist.
              </div>
            ) : (
              <div className="divide-y divide-border/20">
                {visibleEntries.map((entry, i) => {
                  const quote = listQueries[i]?.data;
                  const isSelected = selectedTicker === entry.ticker;
                  const dayChg = quote?.dayChange ?? 0;
                  const dayChgPct = quote?.dayChangePercent ?? 0;
                  
                  const isPositive = dayChg >= 0;
                  const chgColor = isPositive ? "text-green-500" : "text-red-500";
                  const chgSign = isPositive ? "+" : "";

                  return (
                    <div
                      key={entry.ticker}
                      onClick={() => setSelectedTicker(entry.ticker)}
                      className={cn(
                        "grid grid-cols-[16px_1fr_1fr_1fr_1fr] items-center px-4 h-[36px] text-xs cursor-pointer transition-colors group relative",
                        isSelected ? "bg-primary/10" : "hover:bg-secondary/40"
                      )}
                    >
                      <div>
                        {entry.colorTag ? (
                          <div className="w-1.5 h-1.5 rounded-full" style={{ backgroundColor: entry.colorTag }} />
                        ) : (
                          <div className="w-1.5 h-1.5 rounded-full bg-muted-foreground/30" />
                        )}
                      </div>
                      <div 
                        className="font-mono font-bold" 
                        style={{ color: entry.colorTag || 'inherit' }}
                      >
                        {entry.ticker}
                      </div>
                      <div className="text-right font-mono tabular-nums">
                        {quote?.currentPrice ? quote.currentPrice.toFixed(2) : "—"}
                      </div>
                      <div className={cn("text-right font-mono tabular-nums", chgColor)}>
                        {quote?.dayChange !== undefined ? `${chgSign}${dayChg.toFixed(2)}` : "—"}
                      </div>
                      <div className={cn("text-right font-mono tabular-nums", chgColor)}>
                        {quote?.dayChangePercent !== undefined ? `${chgSign}${(dayChgPct * 100).toFixed(2)}%` : "—"}
                      </div>

                      {/* Remove Button */}
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          removeEntry(entry.ticker);
                          if (selectedTicker === entry.ticker) setSelectedTicker(null);
                        }}
                        className="absolute right-2 top-1/2 -translate-y-1/2 opacity-0 group-hover:opacity-100 p-1 hover:bg-background/80 rounded-md transition-all text-muted-foreground hover:text-foreground"
                      >
                        <X className="w-3 h-3" />
                      </button>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>

        {/* Right Panel */}
        <div className="flex-1 bg-background overflow-y-auto">
          {!selectedTicker ? (
            <div className="h-full flex flex-col items-center justify-center text-muted-foreground/60 space-y-4">
              <div className="w-16 h-16 rounded-2xl bg-secondary/50 flex items-center justify-center border border-dashed border-border">
                <BarChart2 className="w-8 h-8" />
              </div>
              <p className="text-sm font-medium">Select a security from your watchlist</p>
            </div>
          ) : !detailQuote ? (
            <div className="h-full flex items-center justify-center">
              <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
            </div>
          ) : (
            <div className="p-6 max-w-4xl mx-auto space-y-6">
              
              {/* Header */}
              <div className="flex justify-between items-end">
                <div>
                  <h1 className="text-3xl font-bold font-mono tracking-tight flex items-center gap-3">
                    {detailQuote.ticker}
                    <span className="text-lg font-sans font-medium text-muted-foreground">
                      {detailQuote.companyName}
                    </span>
                  </h1>
                  <p className="text-xs text-muted-foreground mt-1 uppercase tracking-wider">
                    {detailQuote.sector || "Unknown Sector"} • {detailQuote.industry || "Unknown Industry"}
                  </p>
                </div>
                <div className="text-right">
                  <div className="text-4xl font-bold font-mono tracking-tight">
                    ${detailQuote.currentPrice?.toFixed(2)}
                  </div>
                  <div className={cn(
                    "text-sm font-mono font-medium mt-1",
                    (detailQuote.dayChange ?? 0) >= 0 ? "text-green-500" : "text-red-500"
                  )}>
                    {(detailQuote.dayChange ?? 0) >= 0 ? "+" : ""}
                    {detailQuote.dayChange?.toFixed(2)} (
                    {(detailQuote.dayChangePercent ?? 0) >= 0 ? "+" : ""}
                    {((detailQuote.dayChangePercent ?? 0) * 100).toFixed(2)}%)
                  </div>
                </div>
              </div>

              {/* Chart */}
              <div className="h-[280px]">
                <PriceChart 
                  tickers={[selectedTicker]} 
                  loadedStocks={[detailQuote]}
                  selectedPeriod={chartPeriod}
                  onPeriodChange={setChartPeriod}
                />
              </div>

              {/* Description */}
              {detailQuote.description && (
                <div className="border-t border-border/40 pt-4 mt-4">
                  <p className={cn(
                    "text-sm italic text-muted-foreground leading-relaxed",
                    !descExpanded && "line-clamp-3"
                  )}>
                    {detailQuote.description}
                  </p>
                  {detailQuote.description.length > 200 && (
                    <button 
                      onClick={() => setDescExpanded(!descExpanded)}
                      className="text-xs text-primary hover:underline mt-2 font-medium"
                    >
                      {descExpanded ? "Show less" : "Read more"}
                    </button>
                  )}
                </div>
              )}

              {/* Performance */}
              <div className="border-t border-border/40 pt-4 mt-4">
                <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-widest mb-3">Performance</h3>
                <div className="flex flex-wrap gap-2">
                  <PerformancePill label="1W" data={history1W} />
                  <PerformancePill label="1M" data={history1M} />
                  <PerformancePill label="3M" data={history3M} />
                </div>
              </div>

              {/* Key Metrics */}
              <div className="border-t border-border/40 pt-4 mt-4">
                <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-widest mb-4">Key Metrics</h3>
                <div className="grid grid-cols-2 gap-y-4 gap-x-8 text-sm">
                  <div className="flex justify-between py-1 border-b border-border/30">
                    <span className="text-muted-foreground">P/E Ratio</span>
                    <span className="font-mono font-medium">{formatNumber(detailQuote.peRatio)}</span>
                  </div>
                  <div className="flex justify-between py-1 border-b border-border/30">
                    <span className="text-muted-foreground">PEG Ratio</span>
                    <span className="font-mono font-medium">{formatNumber(detailQuote.pegRatio)}</span>
                  </div>
                  <div className="flex justify-between py-1 border-b border-border/30">
                    <span className="text-muted-foreground">Gross Margin</span>
                    <span className="font-mono font-medium">{((detailQuote.grossMargin ?? 0) * 100).toFixed(2)}%</span>
                  </div>
                  <div className="flex justify-between py-1 border-b border-border/30">
                    <span className="text-muted-foreground">Net Margin</span>
                    <span className="font-mono font-medium">{((detailQuote.netMargin ?? 0) * 100).toFixed(2)}%</span>
                  </div>
                  <div className="flex justify-between py-1 border-b border-border/30">
                    <span className="text-muted-foreground">ROE</span>
                    <span className="font-mono font-medium">{((detailQuote.returnOnEquity ?? 0) * 100).toFixed(2)}%</span>
                  </div>
                  <div className="flex justify-between py-1 border-b border-border/30">
                    <span className="text-muted-foreground">Beta</span>
                    <span className="font-mono font-medium">{formatNumber(detailQuote.beta)}</span>
                  </div>
                  <div className="flex justify-between py-1 border-b border-border/30">
                    <span className="text-muted-foreground">52W High</span>
                    <span className="font-mono font-medium">{formatCurrency(detailQuote.fiftyTwoWeekHigh)}</span>
                  </div>
                  <div className="flex justify-between py-1 border-b border-border/30">
                    <span className="text-muted-foreground">52W Low</span>
                    <span className="font-mono font-medium">{formatCurrency(detailQuote.fiftyTwoWeekLow)}</span>
                  </div>
                  <div className="flex justify-between py-1 border-b border-border/30 col-span-2 sm:col-span-1">
                    <span className="text-muted-foreground">Market Cap</span>
                    <span className="font-mono font-medium">{formatLargeNumber(detailQuote.marketCap)}</span>
                  </div>
                </div>
              </div>

              {/* Analyst */}
              <div className="border-t border-border/40 pt-4 mt-4 pb-8">
                <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-widest mb-4">Analyst</h3>
                <div className="bg-secondary/20 rounded-lg p-4 flex items-center justify-between border border-border/40 max-w-md">
                  <div>
                    <div className="text-xs text-muted-foreground mb-1">Target Price</div>
                    <div className="text-xl font-bold font-mono">
                      {formatCurrency(detailQuote.analystTargetPrice)}
                    </div>
                  </div>
                  {detailQuote.analystTargetPrice && detailQuote.currentPrice && (
                    <div className="text-right">
                      <div className="text-xs text-muted-foreground mb-1">Upside</div>
                      <div className={cn(
                        "text-lg font-bold font-mono",
                        detailQuote.analystTargetPrice > detailQuote.currentPrice ? "text-green-500" : "text-red-500"
                      )}>
                        {((detailQuote.analystTargetPrice / detailQuote.currentPrice - 1) * 100).toFixed(2)}%
                      </div>
                    </div>
                  )}
                </div>
              </div>

            </div>
          )}
        </div>
        
      </main>
    </div>
  );
}
