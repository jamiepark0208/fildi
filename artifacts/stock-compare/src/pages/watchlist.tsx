import { useState, useRef, useMemo, useCallback, useEffect } from "react";
import { useSearch, Link } from "wouter";
import { TopNav } from "@/components/top-nav";
import { useWatchlist, PRESET_COLORS, COLOR_LABELS } from "@/hooks/use-watchlist";
import { useQuery } from "@tanstack/react-query";
import {
  useSearchStocks,
  getSearchStocksQueryKey,
} from "@workspace/api-client-react";
import { StockBreakdown } from "@/components/stock-breakdown";
import { ModelListPanel, WATCHLIST_ROW_MINE, modelThesisSelectionKey } from "@/components/model-list-panel";
import type { ModelThesis } from "@/components/model-thesis-report";
import { ResizablePanelGroup, ResizablePanel, ResizableHandle } from "@/components/ui/resizable";
import { Search, Loader2, X, BarChart2, ChevronUp, ChevronDown, ChevronsUpDown } from "lucide-react";
import { useDebounce } from "@/hooks/use-debounce";
import { useSessionState } from "@/hooks/use-session-state";
import { cn } from "@/lib/utils";
import { DataTip } from "@/components/data-tip";

// ── Tab button ────────────────────────────────────────────────────────────────

// ── Watchlist list view ────────────────────────────────────────────────────────

/** Price/chg row fields from /live/prices (percent points → StockMetrics-style decimals). */
type ListQuote = {
  currentPrice?: number;
  dayChange?: number;
  dayChangePercent?: number;
  source?: string;
  asOf?: string;
};

function listQuoteFromLive(
  live: { price: number | null; changePercent: number | null; source?: string; asOf?: string } | undefined,
): ListQuote | undefined {
  if (!live || live.price == null) return undefined;
  const pctPts = live.changePercent; // e.g. -6.83 = -6.83%
  const dayChangePercent = pctPts != null ? pctPts / 100 : undefined;
  const dayChange =
    pctPts != null ? live.price * (pctPts / 100) / (1 + pctPts / 100) : undefined;
  return {
    currentPrice: live.price,
    dayChange,
    dayChangePercent,
    source: live.source,
    asOf: live.asOf,
  };
}

function quoteTip(q: ListQuote | undefined, label: string): string {
  const src = q?.source ? `${q.source} (live ≤60s)` : "Schwab→Yahoo live ≤60s";
  const asOf = q?.asOf ? ` · as of ${q.asOf.slice(11, 16)}Z` : "";
  return `${label} · sourced · ${src}${asOf}`;
}

type SortField = "symbol" | "last" | "chg" | "chgPct" | "streetGap";
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
  const [modelThesis, setModelThesis] = useState<ModelThesis | null>(null);
  const search = useSearch();

  // Deep-link support: /watchlist?ticker=XYZ selects that ticker on load (used by
  // the old /breakdown route redirect and any other cross-page "view breakdown" CTA).
  useEffect(() => {
    const ticker = new URLSearchParams(search).get("ticker");
    if (ticker) {
      setSelectedTicker(ticker.toUpperCase());
      setModelThesis(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search]);

  const [tab, setTab] = useSessionState<"mine" | "model">("fildi_watchlist_tab", "mine");

  const selectMine = useCallback((ticker: string) => {
    setSelectedTicker(ticker);
    setModelThesis(null);
  }, [setSelectedTicker]);

  const selectModelThesis = useCallback((thesis: ModelThesis) => {
    setSelectedTicker(thesis.item.ticker);
    setModelThesis(thesis);
  }, [setSelectedTicker]);
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

  const selectTickerForAdd = useCallback(async (ticker: string) => {
    const upper = ticker.toUpperCase();
    const ok = await addEntry(upper);
    if (ok) setColorPickerTicker(upper);
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

  // Golden-source batch (Schwab→Yahoo, 60s TTL) — same path as Options/Live.
  // Avoid /stocks/quotes here: that fans out full Yahoo quoteSummary × concurrency 6
  // (~10–20s for a 50-name list) for fields My List never shows.
  const { data: livePrices } = useQuery({
    queryKey: ["live-prices", tickerKey],
    queryFn: async (): Promise<Record<string, {
      price: number | null;
      changePercent: number | null;
      source?: string;
      asOf?: string;
    }>> => {
      const res = await fetch(`/api/live/prices?tickers=${encodeURIComponent(tickerKey)}`, {
        credentials: "include",
      });
      if (!res.ok) throw new Error("live/prices failed");
      const body = await res.json() as {
        prices: Record<string, {
          price: number | null;
          changePercent: number | null;
          source?: string;
          asOf?: string;
        }>;
      };
      return body.prices ?? {};
    },
    enabled: tickerKey.length > 0,
    staleTime: 90_000,
    refetchInterval: 120_000, // match LIVE_PRICE_TTL_MS
  });

  // DB-only name/sector/industry for breakdown tag popups (no Yahoo).
  const { data: watchlistMeta } = useQuery({
    queryKey: ["watchlist-meta", tickerKey],
    queryFn: async (): Promise<Record<string, {
      companyName?: string | null; sector?: string | null; industry?: string | null;
      stockType?: string | null; streetGapPct?: number | null; streetGapBasis?: "fv" | "price" | null;
    }>> => {
      const res = await fetch("/api/watchlist/meta", { credentials: "include" });
      if (!res.ok) throw new Error("watchlist meta failed");
      return res.json();
    },
    enabled: tickerKey.length > 0,
    staleTime: 30 * 60 * 1000,
  });

  // Build quote map for sort access before sorting
  const quoteMap = useMemo(() => {
    const m: Record<string, ListQuote | undefined> = {};
    filteredEntries.forEach((e) => {
      m[e.ticker] = listQuoteFromLive(livePrices?.[e.ticker]);
    });
    return m;
  }, [filteredEntries, livePrices]);

  const watchlistTagMetrics = useMemo(() => {
    const m: Record<string, { companyName?: string | null; exchange?: string | null; sector?: string | null; industry?: string | null; stockType?: string | null } | undefined> = {};
    for (const e of entries) {
      const meta = watchlistMeta?.[e.ticker];
      if (meta) m[e.ticker] = meta;
    }
    return m;
  }, [entries, watchlistMeta]);

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
      } else if (sortField === "streetGap") {
        va = Math.abs(watchlistMeta?.[a.ticker]?.streetGapPct ?? -1);
        vb = Math.abs(watchlistMeta?.[b.ticker]?.streetGapPct ?? -1);
        // nulls last
        if (watchlistMeta?.[a.ticker]?.streetGapPct == null) va = -1;
        if (watchlistMeta?.[b.ticker]?.streetGapPct == null) vb = -1;
      } else {
        va = qa?.dayChangePercent ?? 0;
        vb = qb?.dayChangePercent ?? 0;
      }
      return sortDir === "asc" ? va - vb : vb - va;
    });
    return sorted;
  }, [filteredEntries, quoteMap, sortField, sortDir, watchlistMeta]);

  const usedColors = useMemo(() => {
    const colors = new Set<string>();
    entries.forEach(e => { if (e.colorTag) colors.add(e.colorTag); });
    return Array.from(colors);
  }, [entries]);

  if (!isLoaded) {
    return (
      <div className="flex-1 flex items-center justify-center bg-zinc-950 text-amber-100/80 text-sm gap-2">
        <Loader2 className="w-4 h-4 animate-spin" />
        Loading watchlist…
      </div>
    );
  }

  return (
    <ResizablePanelGroup direction="horizontal" autoSaveId="fildi-watchlist-panels-v5" className="flex-1 min-h-0 overflow-hidden">
      {/* Left Panel — hug row content (Sym/Last/Chg/%); no ellipsis, minimal spare */}
      <ResizablePanel defaultSize={18} minSize={14} maxSize={28} className="flex flex-col bg-zinc-950 min-w-[15rem] min-h-0" data-lenis-prevent>
        <div className="flex border-b border-[#d4af37]/20 text-[11px] font-bold shrink-0">
          {([["mine", "My List"], ["model", "Model List"]] as const).map(([key, label]) => {
            const active = tab === key;
            const modelTab = key === "model";
            return (
              <button
                key={key}
                onClick={() => {
                  setTab(key);
                  if (key === "mine") setModelThesis(null);
                }}
                className={cn(
                  "flex-1 py-1.5 transition-colors border-b-2",
                  active && !modelTab && "text-[#d4af37] border-[#d4af37]",
                  active && modelTab && "text-emerald-400 border-emerald-400",
                  !active && !modelTab && "text-amber-200/35 border-transparent hover:text-amber-200/70",
                  !active && modelTab && "text-emerald-400/40 border-transparent hover:text-emerald-300/70",
                )}
              >
                {label}
              </button>
            );
          })}
        </div>

        {tab === "model" ? (
          <ModelListPanel
            selectedKey={modelThesis ? modelThesisSelectionKey(modelThesis) : null}
            onSelectThesis={selectModelThesis}
          />
        ) : (<>
        <div className="p-2 border-b border-[#d4af37]/20 shrink-0">
          <div className="relative">
              <Search className="absolute left-2 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-amber-100/80 z-10" />
              {isSearching && debouncedSearch.length >= 2 && (
                <Loader2 className="absolute right-2 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-amber-100/80 animate-spin z-10" />
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
                placeholder="Add…"
                className="w-full h-7 pl-7 pr-7 text-[11px] bg-zinc-900 border border-[#d4af37]/35 rounded-md text-white placeholder:text-white/45 focus:outline-none focus:ring-2 focus:ring-[#d4af37] transition-colors"
              />

              {open && debouncedSearch.length >= 2 && (
                <div className="absolute top-full left-0 right-0 mt-1 z-50 bg-zinc-950 border border-[#d4af37]/25 rounded-md shadow-xl overflow-hidden max-h-60 overflow-y-auto">
                  {isSearching && (!searchResults || searchResults.length === 0) ? (
                    <div className="px-2 py-2 text-xs text-amber-200/40">Searching...</div>
                  ) : visibleResults.length === 0 ? (
                    <div className="px-2 py-2 text-xs text-amber-200/40">No results</div>
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
                            "px-2 py-1 text-[11px] cursor-pointer flex items-center gap-1.5 hover:bg-[#d4af37]/10",
                            i === focusedIndex && "bg-[#d4af37]/10"
                          )}
                        >
                          <span className="font-mono font-bold text-white w-12 shrink-0">{r.ticker}</span>
                          <span className="text-amber-200/40 truncate">{r.name}</span>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              )}
            </div>

          <div className="mt-1.5 flex items-center gap-1 overflow-x-auto pb-0.5 scrollbar-none">
            <button
              onClick={() => setFilterColor(null)}
              className={cn(
                "text-[9px] px-1.5 py-0.5 rounded-full font-medium transition-colors border shrink-0",
                !filterColor ? "bg-zinc-800 text-white border-[#d4af37]/60" : "bg-transparent text-amber-100 border-transparent hover:bg-white/5 hover:text-white"
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
                  "w-3 h-3 rounded-full flex-shrink-0 transition-transform border border-transparent",
                  filterColor === c && "ring-2 ring-[#d4af37] ring-offset-1 ring-offset-zinc-950"
                )}
                style={{ backgroundColor: c }}
              />
            ))}
          </div>
        </div>

        <div className={cn(WATCHLIST_ROW_MINE, "border-b border-[#d4af37]/20 text-[#d4af37] sticky top-0 bg-zinc-950/95 backdrop-blur-md z-10 shrink-0")}>
          <div />
          <button onClick={() => handleSort("symbol")} className="w-full flex items-center gap-0.5 text-[9px] font-bold uppercase tracking-wider hover:text-amber-200 select-none text-left min-w-0">
            Sym<SortIcon field="symbol" sortField={sortField} sortDir={sortDir} />
          </button>
          <button onClick={() => handleSort("last")} className="w-full flex items-center justify-end gap-0.5 text-[9px] font-bold uppercase tracking-wider hover:text-amber-200 select-none min-w-0">
            Last<SortIcon field="last" sortField={sortField} sortDir={sortDir} />
          </button>
          <button onClick={() => handleSort("chg")} className="w-full flex items-center justify-end gap-0.5 text-[9px] font-bold uppercase tracking-wider hover:text-amber-200 select-none min-w-0">
            Chg<SortIcon field="chg" sortField={sortField} sortDir={sortDir} />
          </button>
          <button onClick={() => handleSort("chgPct")} className="w-full flex items-center justify-end gap-0.5 text-[9px] font-bold uppercase tracking-wider hover:text-amber-200 select-none min-w-0">
            %<SortIcon field="chgPct" sortField={sortField} sortDir={sortDir} />
          </button>
          <button onClick={() => handleSort("streetGap")} title="Fildi FV vs street PT (A86 review)" className="w-full flex items-center justify-end gap-0.5 text-[9px] font-bold uppercase tracking-wider hover:text-amber-200 select-none min-w-0">
            vsSt<SortIcon field="streetGap" sortField={sortField} sortDir={sortDir} />
          </button>
          <div />
        </div>

        {/* data-lenis-prevent: A127 Lenis owns document wheel; without this My List can't scroll */}
        <div className="flex-1 overflow-y-auto min-h-0 overscroll-contain" data-lenis-prevent>
          {visibleEntries.length === 0 ? (
            <div className="p-4 text-center text-xs text-amber-200/40 space-y-2">
              {entries.length === 0 ? (
                <>
                  <p>No tickers.</p>
                  <p>
                    <Link href="/options-scanner" className="text-[#d4af37] hover:underline">
                      Add from scanner
                    </Link>
                  </p>
                </>
              ) : (
                <p>No match for this filter.</p>
              )}
            </div>
          ) : (
            <div className="divide-y divide-[#d4af37]/10">
              {visibleEntries.map((entry) => {
                const quote = quoteMap[entry.ticker];
                const isSelected = selectedTicker === entry.ticker && !modelThesis;
                const dayChg = quote?.dayChange ?? 0;
                const dayChgPct = quote?.dayChangePercent ?? 0;
                const isPositive = dayChg >= 0;
                const chgColor = isPositive ? "text-green-500" : "text-red-500";
                const chgSign = isPositive ? "+" : "";
                const isTagging = colorPickerTicker === entry.ticker;
                return (
                  <div key={entry.ticker} className={cn("transition-colors", isSelected ? "bg-[#d4af37]/15" : "hover:bg-[#d4af37]/10")}>
                    <div
                      onClick={() => selectMine(entry.ticker)}
                      className={cn(WATCHLIST_ROW_MINE, "cursor-pointer")}
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
                      <div className="font-mono font-bold whitespace-nowrap" style={{ color: entry.colorTag || "white" }}>
                        {entry.ticker}
                      </div>
                      <DataTip tip={quoteTip(quote, "Last")} className="justify-end w-full">
                        <div className="text-right font-mono tabular-nums text-white whitespace-nowrap w-full">
                          {quote?.currentPrice != null ? quote.currentPrice.toFixed(2) : "—"}
                        </div>
                      </DataTip>
                      <DataTip tip={quoteTip(quote, "Chg $")} className="justify-end w-full">
                        <div className={cn("text-right font-mono tabular-nums whitespace-nowrap w-full", chgColor)}>
                          {quote?.dayChange !== undefined ? `${chgSign}${dayChg.toFixed(2)}` : "—"}
                        </div>
                      </DataTip>
                      <DataTip tip={quoteTip(quote, "Chg %")} className="justify-end w-full">
                        <div className={cn("text-right font-mono tabular-nums whitespace-nowrap w-full", chgColor)}>
                          {quote?.dayChangePercent !== undefined ? `${chgSign}${(dayChgPct * 100).toFixed(1)}%` : "—"}
                        </div>
                      </DataTip>
                      {(() => {
                        const g = watchlistMeta?.[entry.ticker]?.streetGapPct;
                        const basis = watchlistMeta?.[entry.ticker]?.streetGapBasis;
                        // Lower (more negative) = FV / price below street PT → green; above street → red.
                        const vsColor =
                          g == null
                            ? "text-white/30"
                            : g <= -15
                              ? "text-emerald-400"
                              : g <= -5
                                ? "text-emerald-300/90"
                                : g < 5
                                  ? "text-yellow-300"
                                  : g < 15
                                    ? "text-orange-300"
                                    : "text-red-400";
                        const tip = g == null
                          ? "vsSt · Fildi FV (or price) vs LSEG street PT — lower = cheaper vs street"
                          : basis === "price"
                            ? `vsSt · price vs street PT ${g >= 0 ? "+" : ""}${g.toFixed(0)}% (no Fildi FV). Lower = cheaper.`
                            : `vsSt · Fildi FV vs street PT ${g >= 0 ? "+" : ""}${g.toFixed(0)}%. Lower = cheaper vs street.`;
                        return (
                          <DataTip tip={tip} className="justify-end w-full">
                            <div
                              className={cn(
                                "text-right font-mono tabular-nums whitespace-nowrap text-[11px] w-full font-semibold",
                                vsColor,
                              )}
                            >
                              {g == null ? "—" : `${g >= 0 ? "+" : ""}${g.toFixed(0)}`}
                            </div>
                          </DataTip>
                        );
                      })()}
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          removeEntry(entry.ticker);
                          if (selectedTicker === entry.ticker) {
                            setSelectedTicker(null);
                            setModelThesis(null);
                          }
                          if (colorPickerTicker === entry.ticker) setColorPickerTicker(null);
                        }}
                        title={`Remove ${entry.ticker}`}
                        className="flex items-center justify-center text-amber-100/80 hover:text-red-400 hover:bg-red-500/20 rounded transition-colors"
                      >
                        <X className="w-3 h-3" />
                      </button>
                    </div>
                    {isTagging && (
                      <div className="px-2 pb-1 flex items-center gap-1" onClick={e => e.stopPropagation()}>
                        <span className="text-[9px] text-amber-200/40">Tag</span>
                        {PRESET_COLORS.map(c => (
                          <button
                            key={c}
                            onClick={() => { updateColorTag(entry.ticker, c); setColorPickerTicker(null); }}
                            title={COLOR_LABELS[c] ?? undefined}
                            className={cn("w-3 h-3 rounded-full hover:scale-125 transition-transform shrink-0", entry.colorTag === c && "ring-2 ring-white/60 ring-offset-1 ring-offset-zinc-950")}
                            style={{ backgroundColor: c }}
                          />
                        ))}
                        <button
                          onClick={() => { updateColorTag(entry.ticker, ""); setColorPickerTicker(null); }}
                          className="w-3 h-3 rounded-full border border-dashed border-white/30 hover:border-white/60 transition-colors shrink-0"
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
        </>)}
      </ResizablePanel>

      <ResizableHandle className="bg-[#d4af37]/15 hover:bg-[#d4af37]/40 transition-colors w-[3px]" />

      <ResizablePanel defaultSize={87} className="bg-zinc-900 overflow-hidden flex flex-col min-h-0 min-w-0">
        {!selectedTicker ? (
          <div className="h-full flex flex-col items-center justify-center text-amber-200/30 space-y-4">
            <div className="w-16 h-16 rounded-2xl bg-zinc-950 flex items-center justify-center border border-dashed border-[#d4af37]/25">
              <BarChart2 className="w-8 h-8" />
            </div>
            <p className="text-sm font-medium">Select a security</p>
          </div>
        ) : (
          <div className="h-full min-h-0 flex flex-col" data-lenis-prevent>
            <StockBreakdown
              ticker={selectedTicker}
              watchlistMetrics={watchlistTagMetrics}
              modelThesis={modelThesis}
            />
          </div>
        )}
      </ResizablePanel>
    </ResizablePanelGroup>
  );
}

// ── Main Watchlist page ───────────────────────────────────────────────────────

export default function Watchlist() {
  return (
    <div className="h-[100dvh] overflow-hidden bg-zinc-900 text-foreground">
      <TopNav />
      {/* min-h-0: flex child must shrink or breakdown overflow-y-auto never engages (Lenis + Model List click).
          h+[overflow-hidden] on shell: stop main.mt-14 margin-collapse → document scroll (Lenis trap). */}
      <main className="flex flex-col mt-14 h-[calc(100dvh-3.5rem)] min-h-0 overflow-hidden">
        <WatchlistView />
      </main>
    </div>
  );
}
