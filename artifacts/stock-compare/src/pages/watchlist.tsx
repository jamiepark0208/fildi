import { useState, useRef, useMemo, useCallback } from "react";
import { Sidebar } from "@/components/sidebar";
import { useWatchlist, PRESET_COLORS } from "@/hooks/use-watchlist";
import { useQueries } from "@tanstack/react-query";
import {
  getGetStockQuoteQueryOptions,
  useSearchStocks,
  getSearchStocksQueryKey,
  StockMetrics
} from "@workspace/api-client-react";
import { StockBreakdown } from "@/components/stock-breakdown";
import { Search, Loader2, X, BarChart2, ChevronUp, ChevronDown, ChevronsUpDown } from "lucide-react";
// Loader2 used in search dropdown
import { useDebounce } from "@/hooks/use-debounce";
import { cn } from "@/lib/utils";

// ── Tab button ────────────────────────────────────────────────────────────────

// ── Watchlist list view ────────────────────────────────────────────────────────

type SortField = "symbol" | "last" | "chg" | "chgPct";
type SortDir = "asc" | "desc";

function SortIcon({ field, sortField, sortDir }: { field: SortField; sortField: SortField; sortDir: SortDir }) {
  if (field !== sortField) return <ChevronsUpDown className="w-3 h-3 opacity-30 inline ml-0.5" />;
  return sortDir === "asc"
    ? <ChevronUp className="w-3 h-3 inline ml-0.5" />
    : <ChevronDown className="w-3 h-3 inline ml-0.5" />;
}

function WatchlistView() {
  const { entries, isLoaded, addEntry, removeEntry } = useWatchlist();
  const [selectedTicker, setSelectedTicker] = useState<string | null>(null);
  const [filterColor, setFilterColor] = useState<string | null>(null);
  const [sortField, setSortField] = useState<SortField>("symbol");
  const [sortDir, setSortDir] = useState<SortDir>("asc");

  const handleSort = (field: SortField) => {
    if (sortField === field) {
      setSortDir(d => d === "asc" ? "desc" : "asc");
    } else {
      setSortField(field);
      setSortDir(field === "symbol" ? "asc" : "desc");
    }
  };

  const [inputText, setInputText] = useState("");
  const [open, setOpen] = useState(false);
  const [focusedIndex, setFocusedIndex] = useState(-1);
  const [showColorPicker, setShowColorPicker] = useState<string | null>(null);

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

  const filteredEntries = useMemo(() => {
    if (!filterColor) return entries;
    return entries.filter(e => e.colorTag === filterColor);
  }, [entries, filterColor]);

  const listQueries = useQueries({
    queries: filteredEntries.map((entry) => ({
      ...getGetStockQuoteQueryOptions({ ticker: entry.ticker }),
      staleTime: 5 * 60 * 1000,
    })),
  });

  // Build quote map for sort access before sorting
  const quoteMap = useMemo(() => {
    const m: Record<string, import("@workspace/api-client-react").StockMetrics | undefined> = {};
    filteredEntries.forEach((e, i) => { m[e.ticker] = listQueries[i]?.data; });
    return m;
  }, [filteredEntries, listQueries]);

  const visibleEntries = useMemo(() => {
    const sorted = [...filteredEntries].sort((a, b) => {
      const qa = quoteMap[a.ticker];
      const qb = quoteMap[b.ticker];
      let va = 0, vb = 0;
      if (sortField === "symbol") {
        const r = a.ticker.localeCompare(b.ticker);
        return sortDir === "asc" ? r : -r;
      } else if (sortField === "last") {
        va = qa?.currentPrice ?? 0;
        vb = qb?.currentPrice ?? 0;
      } else if (sortField === "chg") {
        va = qa?.dayChange ?? 0;
        vb = qb?.dayChange ?? 0;
      } else {
        va = qa?.dayChangePercent ?? 0;
        vb = qb?.dayChangePercent ?? 0;
      }
      return sortDir === "asc" ? va - vb : vb - va;
    });
    return sorted;
  }, [filteredEntries, quoteMap, sortField, sortDir]);

  const usedColors = useMemo(() => {
    const colors = new Set<string>();
    entries.forEach(e => { if (e.colorTag) colors.add(e.colorTag); });
    return Array.from(colors);
  }, [entries]);

  if (!isLoaded) return null;

  return (
    <div className="flex-1 flex overflow-hidden">
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
          {(["symbol", "last", "chg", "chgPct"] as SortField[]).map((field, i) => (
            <button
              key={field}
              onClick={() => handleSort(field)}
              className={cn("flex items-center gap-0.5 hover:text-foreground transition-colors select-none", i > 0 && "justify-end")}
            >
              {field === "symbol" ? "Symbol" : field === "last" ? "Last" : field === "chg" ? "Chg" : "Chg%"}
              <SortIcon field={field} sortField={sortField} sortDir={sortDir} />
            </button>
          ))}
        </div>

        {/* Table Body */}
        <div className="flex-1 overflow-y-auto">
          {visibleEntries.length === 0 ? (
            <div className="p-8 text-center text-xs text-muted-foreground">
              No tickers in watchlist.
            </div>
          ) : (
            <div className="divide-y divide-border/20">
              {visibleEntries.map((entry) => {
                const quote = quoteMap[entry.ticker];
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

      {/* Right Panel — full StockBreakdown when a ticker is selected */}
      <div className="flex-1 bg-background overflow-hidden flex flex-col">
        {!selectedTicker ? (
          <div className="h-full flex flex-col items-center justify-center text-muted-foreground/60 space-y-4">
            <div className="w-16 h-16 rounded-2xl bg-secondary/50 flex items-center justify-center border border-dashed border-border">
              <BarChart2 className="w-8 h-8" />
            </div>
            <p className="text-sm font-medium">Select a security from your watchlist</p>
          </div>
        ) : (
          <StockBreakdown ticker={selectedTicker} />
        )}
      </div>
    </div>
  );
}

// ── Main Watchlist page ───────────────────────────────────────────────────────

export default function Watchlist() {
  return (
    <div className="min-h-[100dvh] bg-background text-foreground flex">
      <Sidebar />
      <main className="flex-1 ml-[220px] flex flex-col h-[100dvh] overflow-hidden">
        <div className="shrink-0 border-b border-border bg-background px-6 py-4">
          <h1 className="text-lg font-bold tracking-tight leading-none">Watchlist</h1>
          <p className="text-xs text-muted-foreground mt-0.5">31 tracked tickers across 3 tiers</p>
        </div>
        <WatchlistView />
      </main>
    </div>
  );
}
