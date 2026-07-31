import { useState, useRef, useMemo, useCallback, useEffect } from "react";
import { useSearch, Link } from "wouter";
import { TopNav } from "@/components/top-nav";
import { useWatchlist, PRESET_COLORS, COLOR_LABELS } from "@/hooks/use-watchlist";
import { useQuery } from "@tanstack/react-query";
import {
  useSearchStocks,
  getSearchStocksQueryKey,
  StockMetrics
} from "@workspace/api-client-react";
import { StockBreakdown } from "@/components/stock-breakdown";
import { ResizablePanelGroup, ResizablePanel, ResizableHandle } from "@/components/ui/resizable";
import { Search, Loader2, X, BarChart2, ChevronUp, ChevronDown, ChevronsUpDown } from "lucide-react";
// Loader2 used in search dropdown
import { useDebounce } from "@/hooks/use-debounce";
import { useSessionState } from "@/hooks/use-session-state";
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
  const { entries, isLoaded, addEntry, removeEntry, updateColorTag } = useWatchlist();
  const [selectedTicker, setSelectedTicker] = useSessionState<string | null>("fildi_watchlist_selected_ticker", null);
  const search = useSearch();

  // Deep-link support: /watchlist?ticker=XYZ selects that ticker on load (used by
  // the old /breakdown route redirect and any other cross-page "view breakdown" CTA).
  useEffect(() => {
    const ticker = new URLSearchParams(search).get("ticker");
    if (ticker) setSelectedTicker(ticker.toUpperCase());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search]);

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
  const [colorPickerTicker, setColorPickerTicker] = useState<string | null>(null);

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
    addEntry(upper);
    setColorPickerTicker(upper);
    setInputText("");
    setOpen(false);
    setFocusedIndex(-1);
    inputRef.current?.blur();
  }, [addEntry]);

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

  // Fetched for the full watchlist (not just filteredEntries) so the tag-click popup in
  // StockBreakdown can list matching tickers regardless of the active color filter.
  const tickerKey = useMemo(
    () => [...entries.map(e => e.ticker)].sort().join(","),
    [entries],
  );

  const { data: quotesData } = useQuery({
    queryKey: ["stocks-quotes", tickerKey],
    queryFn: async (): Promise<Record<string, StockMetrics | { error: string }>> => {
      const res = await fetch(`/api/stocks/quotes?tickers=${encodeURIComponent(tickerKey)}`);
      if (!res.ok) throw new Error("quotes fetch failed");
      return res.json();
    },
    enabled: tickerKey.length > 0,
    staleTime: 5 * 60 * 1000,
  });

  // Build quote map for sort access before sorting
  const quoteMap = useMemo(() => {
    const m: Record<string, StockMetrics | undefined> = {};
    filteredEntries.forEach((e) => {
      const q = quotesData?.[e.ticker];
      m[e.ticker] = q && !("error" in q) ? q : undefined;
    });
    return m;
  }, [filteredEntries, quotesData]);

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

  const watchlistTagMetrics = useMemo(() => {
    const m: Record<string, { companyName?: string | null; exchange?: string | null; sector?: string | null; industry?: string | null; stockType?: string | null } | undefined> = {};
    for (const e of entries) {
      const q = quotesData?.[e.ticker];
      if (q && !("error" in q)) {
        m[e.ticker] = { companyName: q.companyName, exchange: q.exchange, sector: q.sector, industry: q.industry, stockType: q.stockType };
      }
    }
    return m;
  }, [entries, quotesData]);

  const usedColors = useMemo(() => {
    const colors = new Set<string>();
    entries.forEach(e => { if (e.colorTag) colors.add(e.colorTag); });
    return Array.from(colors);
  }, [entries]);

  if (!isLoaded) return null;

  return (
    <ResizablePanelGroup direction="horizontal" autoSaveId="fildi-watchlist-panels" className="flex-1 overflow-hidden">
      {/* Left Panel */}
      <ResizablePanel defaultSize={16} minSize={11} maxSize={32} className="flex flex-col bg-zinc-950">
        {/* Search Header */}
        <div className="p-2.5 border-b border-[#d4af37]/20">
          <div className="relative">
              <Search className="absolute left-2 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-gray-500 z-10" />
              {isSearching && debouncedSearch.length >= 2 && (
                <Loader2 className="absolute right-2 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-gray-500 animate-spin z-10" />
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
                className="w-full h-8 pl-7 pr-7 text-xs bg-white border border-white/20 rounded-md text-black placeholder:text-gray-500 focus:outline-none focus:ring-2 focus:ring-[#d4af37] transition-colors"
              />

              {open && debouncedSearch.length >= 2 && (
                <div className="absolute top-full left-0 right-0 mt-1 z-50 bg-zinc-950 border border-[#d4af37]/25 rounded-md shadow-xl overflow-hidden max-h-60 overflow-y-auto">
                  {isSearching && (!searchResults || searchResults.length === 0) ? (
                    <div className="px-3 py-2 text-xs text-amber-200/40">Searching...</div>
                  ) : visibleResults.length === 0 ? (
                    <div className="px-3 py-2 text-xs text-amber-200/40">No results found</div>
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
                            "px-2.5 py-1.5 text-xs cursor-pointer flex items-center justify-between hover:bg-[#d4af37]/10",
                            i === focusedIndex && "bg-[#d4af37]/10"
                          )}
                        >
                          <span className="font-mono font-bold text-white">{r.ticker}</span>
                          <span className="text-amber-200/40 text-[11px] truncate ml-2 max-w-[150px]">{r.name}</span>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              )}
            </div>

          {/* Filter Chips — hover a dot for its tag meaning, no separate legend needed */}
          <div className="mt-2 flex items-center gap-1.5 overflow-x-auto pb-0.5 scrollbar-none">
            <button
              onClick={() => setFilterColor(null)}
              className={cn(
                "text-[10px] px-2 py-0.5 rounded-full font-medium transition-colors border shrink-0",
                !filterColor ? "bg-[#d4af37]/20 text-[#d4af37] border-[#d4af37]/40" : "bg-transparent text-amber-200/40 border-transparent hover:bg-white/5"
              )}
            >
              All
            </button>
            {usedColors.map(c => (
              <button
                key={c}
                onClick={() => setFilterColor(filterColor === c ? null : c)}
                title={COLOR_LABELS[c] ?? undefined}
                className={cn(
                  "w-3.5 h-3.5 rounded-full flex-shrink-0 transition-transform border border-transparent",
                  filterColor === c && "ring-2 ring-[#d4af37] ring-offset-1 ring-offset-zinc-950"
                )}
                style={{ backgroundColor: c }}
              />
            ))}
          </div>
        </div>

        {/* Table Header */}
        <div className="grid grid-cols-[14px_1fr_1fr_1fr_1fr] items-center gap-1 px-2.5 py-1.5 border-b border-[#d4af37]/20 text-[10px] font-bold text-[#d4af37] uppercase tracking-wider sticky top-0 bg-zinc-950/95 backdrop-blur-md z-10">
          <div />
          {(["symbol", "last", "chg", "chgPct"] as SortField[]).map((field, i) => (
            <button
              key={field}
              onClick={() => handleSort(field)}
              className={cn("flex items-center gap-0.5 hover:text-amber-200 transition-colors select-none", i > 0 && "justify-end")}
            >
              {field === "symbol" ? "Sym" : field === "last" ? "Last" : field === "chg" ? "Chg" : "Chg%"}
              <SortIcon field={field} sortField={sortField} sortDir={sortDir} />
            </button>
          ))}
        </div>

        {/* Table Body */}
        <div className="flex-1 overflow-y-auto">
          {visibleEntries.length === 0 ? (
            <div className="p-6 text-center text-xs text-amber-200/40 space-y-2">
              {entries.length === 0 ? (
                <>
                  <p>No tickers in watchlist.</p>
                  <p>
                    <Link href="/options-scanner" className="text-[#d4af37] hover:underline">
                      Add from scanner GO list
                    </Link>
                  </p>
                </>
              ) : (
                <p>No tickers match this color filter.</p>
              )}
            </div>
          ) : (
            <div className="divide-y divide-[#d4af37]/10">
              {visibleEntries.map((entry) => {
                const quote = quoteMap[entry.ticker];
                const isSelected = selectedTicker === entry.ticker;
                const dayChg = quote?.dayChange ?? 0;
                const dayChgPct = quote?.dayChangePercent ?? 0;

                const isPositive = dayChg >= 0;
                const chgColor = isPositive ? "text-green-500" : "text-red-500";
                const chgSign = isPositive ? "+" : "";

                const isTagging = colorPickerTicker === entry.ticker;
                return (
                  <div key={entry.ticker} className={cn("transition-colors", isSelected ? "bg-[#d4af37]/15" : "hover:bg-[#d4af37]/10")}>
                    {/* Main row */}
                    <div
                      onClick={() => setSelectedTicker(entry.ticker)}
                      className="grid grid-cols-[14px_1fr_1fr_1fr_1fr] items-center gap-1 px-2.5 h-[28px] text-[11px] cursor-pointer group relative"
                    >
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          setColorPickerTicker(isTagging ? null : entry.ticker);
                        }}
                        title={entry.colorTag ? (COLOR_LABELS[entry.colorTag] ?? "Set color tag") : "Set color tag"}
                        className="flex items-center justify-center w-3.5 h-3.5 rounded-full hover:ring-1 hover:ring-white/40 transition-all"
                      >
                        {entry.colorTag ? (
                          <div className="w-2 h-2 rounded-full" style={{ backgroundColor: entry.colorTag }} />
                        ) : (
                          <div className="w-2 h-2 rounded-full bg-white/20 hover:bg-white/40" />
                        )}
                      </button>
                      <div className="font-mono font-bold truncate" style={{ color: entry.colorTag || 'white' }}>
                        {entry.ticker}
                      </div>
                      <div className="text-right font-mono tabular-nums text-white">
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
                          if (colorPickerTicker === entry.ticker) setColorPickerTicker(null);
                        }}
                        className="absolute right-1.5 top-1/2 -translate-y-1/2 opacity-0 group-hover:opacity-100 p-0.5 hover:bg-black/60 rounded transition-all text-amber-200/40 hover:text-white"
                      >
                        <X className="w-3 h-3" />
                      </button>
                    </div>
                    {/* Inline color picker */}
                    {isTagging && (
                      <div className="px-2.5 pb-1.5 flex items-center gap-1.5" onClick={e => e.stopPropagation()}>
                        <span className="text-[10px] text-amber-200/40">Tag:</span>
                        {PRESET_COLORS.map(c => (
                          <button
                            key={c}
                            onClick={() => { updateColorTag(entry.ticker, c); setColorPickerTicker(null); }}
                            title={COLOR_LABELS[c] ?? undefined}
                            className={cn("w-3.5 h-3.5 rounded-full hover:scale-125 transition-transform shrink-0", entry.colorTag === c && "ring-2 ring-white/60 ring-offset-1 ring-offset-zinc-950")}
                            style={{ backgroundColor: c }}
                          />
                        ))}
                        <button
                          onClick={() => { updateColorTag(entry.ticker, ""); setColorPickerTicker(null); }}
                          className="w-3.5 h-3.5 rounded-full border border-dashed border-white/30 hover:border-white/60 transition-colors shrink-0"
                          title="Remove tag"
                        />
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </ResizablePanel>

      <ResizableHandle className="bg-[#d4af37]/15 hover:bg-[#d4af37]/40 transition-colors w-[3px]" />

      {/* Right Panel — full StockBreakdown when a ticker is selected */}
      <ResizablePanel defaultSize={84} className="bg-zinc-900 overflow-hidden flex flex-col">
        {!selectedTicker ? (
          <div className="h-full flex flex-col items-center justify-center text-amber-200/30 space-y-4">
            <div className="w-16 h-16 rounded-2xl bg-zinc-950 flex items-center justify-center border border-dashed border-[#d4af37]/25">
              <BarChart2 className="w-8 h-8" />
            </div>
            <p className="text-sm font-medium">Select a security from your watchlist</p>
          </div>
        ) : (
          <StockBreakdown ticker={selectedTicker} watchlistMetrics={watchlistTagMetrics} />
        )}
      </ResizablePanel>
    </ResizablePanelGroup>
  );
}

// ── Main Watchlist page ───────────────────────────────────────────────────────

export default function Watchlist() {
  return (
    <div className="min-h-[100dvh] bg-zinc-900 text-foreground">
      <TopNav />
      <main className="flex flex-col mt-14 h-[calc(100dvh-3.5rem)] overflow-hidden">
        <WatchlistView />
      </main>
    </div>
  );
}
