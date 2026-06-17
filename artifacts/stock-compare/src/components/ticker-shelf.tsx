import { useState, useRef, useCallback } from "react";
import { useSearchStocks, getSearchStocksQueryKey } from "@workspace/api-client-react";
import { Search, Loader2, X } from "lucide-react";
import { useDebounce } from "@/hooks/use-debounce";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";

interface TickerShelfProps {
  tickers: string[];
  loadingTickers: Record<string, boolean>;
  onAdd: (ticker: string) => void;
  onRemove: (ticker: string) => void;
  /** When provided, filter from this list locally instead of calling the external search API. */
  suggestions?: string[];
}

export function TickerShelf({ tickers, loadingTickers, onAdd, onRemove, suggestions }: TickerShelfProps) {
  const [inputText, setInputText] = useState("");
  const [open, setOpen] = useState(false);
  const [focusedIndex, setFocusedIndex] = useState(-1);
  const inputRef = useRef<HTMLInputElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const closeTimeout = useRef<ReturnType<typeof setTimeout> | null>(null);

  const debouncedSearch = useDebounce(inputText, 180);

  const { data: apiResults, isFetching } = useSearchStocks(
    { q: debouncedSearch },
    {
      query: {
        enabled: !suggestions && debouncedSearch.length >= 2,
        queryKey: getSearchStocksQueryKey({ q: debouncedSearch }),
        staleTime: 5 * 60 * 1000,
        gcTime: 10 * 60 * 1000,
      },
    }
  );

  const results = suggestions
    ? (debouncedSearch.length >= 1
        ? suggestions
            .filter(t => t.includes(debouncedSearch) && !tickers.includes(t))
            .map(t => ({ ticker: t, name: t, exchange: "", type: "EQUITY" }))
        : [])
    : (apiResults ?? []);

  const visibleResults = open && results.length > 0 ? results : [];

  const selectTicker = useCallback((ticker: string) => {
    const upper = ticker.toUpperCase().trim();
    if (upper && !tickers.includes(upper)) {
      onAdd(upper);
    }
    setInputText("");
    setOpen(false);
    setFocusedIndex(-1);
    setTimeout(() => inputRef.current?.focus(), 0);
  }, [onAdd, tickers]);

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const val = e.target.value.toUpperCase();
    if (val.includes(",")) {
      const parts = val.split(",");
      const toAdd = parts.slice(0, -1).map(t => t.trim()).filter(Boolean);
      for (const t of toAdd) onAdd(t);
      setInputText(parts[parts.length - 1].trim());
      setOpen(false);
      setFocusedIndex(-1);
      return;
    }
    setInputText(val);
    setOpen(true);
    setFocusedIndex(-1);
  };

  const handleFocus = () => {
    if (closeTimeout.current) clearTimeout(closeTimeout.current);
    if (inputText.length >= 2) setOpen(true);
  };

  const handleBlur = () => {
    closeTimeout.current = setTimeout(() => setOpen(false), 150);
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (!open || visibleResults.length === 0) {
      if (e.key === "Enter" && inputText.trim()) {
        e.preventDefault();
        const parts = inputText.split(",").map(t => t.trim()).filter(Boolean);
        if (parts.length > 1) {
          for (const t of parts) onAdd(t.toUpperCase());
          setInputText("");
          setOpen(false);
          setFocusedIndex(-1);
          setTimeout(() => inputRef.current?.focus(), 0);
        } else {
          selectTicker(inputText.trim());
        }
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
        const r = visibleResults[focusedIndex];
        selectTicker(r.ticker);
      } else if (inputText.trim()) {
        selectTicker(inputText.trim());
      } else {
        setOpen(false);
      }
    } else if (e.key === "Escape") {
      setOpen(false);
    }
  };

  const showDropdown = open && debouncedSearch.length >= 2;
  const isAtLimit = tickers.length >= 5;

  return (
    <div className="flex flex-wrap items-center gap-2" ref={containerRef}>
      {tickers.map(ticker => (
        <div
          key={ticker}
          className="flex items-center gap-2 px-3 py-1.5 bg-secondary text-secondary-foreground rounded-full text-sm font-bold shadow-sm"
        >
          {loadingTickers[ticker] ? (
            <Loader2 className="w-4 h-4 animate-spin text-muted-foreground" />
          ) : (
            <span className="font-mono tracking-tight">{ticker}</span>
          )}
          <button
            onClick={() => onRemove(ticker)}
            className="hover:bg-background/20 rounded-full p-0.5 transition-colors"
            title="Remove ticker"
          >
            <X className="w-3 h-3" />
          </button>
        </div>
      ))}

      {!isAtLimit && (
        <div className="relative w-48">
          <Search className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground z-10" />
          {isFetching && debouncedSearch.length >= 2 && (
            <Loader2 className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground animate-spin z-10" />
          )}
          <input
            ref={inputRef}
            type="text"
            autoComplete="off"
            autoCorrect="off"
            autoCapitalize="characters"
            spellCheck={false}
            value={inputText}
            onChange={handleChange}
            onFocus={handleFocus}
            onBlur={handleBlur}
            onKeyDown={handleKeyDown}
            placeholder="Add ticker, AAPL, MSFT…"
            className={cn(
              "w-full h-8 pl-8 pr-8 text-sm font-mono uppercase rounded-full border border-border bg-card",
              "text-foreground placeholder:text-muted-foreground/50",
              "focus:outline-none focus:ring-1 focus:ring-primary focus:border-primary",
              "transition-colors"
            )}
          />

          {showDropdown && (
            <div className="absolute top-full left-0 right-auto min-w-[240px] mt-1 z-50 rounded-md border border-border bg-card shadow-xl overflow-hidden">
              {isFetching && (!results || results.length === 0) ? (
                <div className="px-4 py-3 text-sm text-muted-foreground flex items-center gap-2">
                  <Loader2 className="h-3 w-3 animate-spin" /> Searching...
                </div>
              ) : visibleResults.length === 0 ? (
                <div className="px-4 py-3 text-sm text-muted-foreground">No results for "{debouncedSearch}"</div>
              ) : (
                <ul className="max-h-56 overflow-y-auto py-1">
                  {visibleResults.map((r, i) => (
                    <li
                      key={r.ticker}
                      onMouseDown={(e) => {
                        e.preventDefault();
                        selectTicker(r.ticker);
                      }}
                      className={cn(
                        "flex items-center justify-between px-4 py-2.5 cursor-pointer select-none",
                        "hover:bg-primary/10 transition-colors",
                        i === focusedIndex && "bg-primary/15"
                      )}
                    >
                      <span className="font-mono font-bold text-foreground">{r.ticker}</span>
                      <span className="text-muted-foreground text-sm truncate ml-4 max-w-[160px]">{r.name}</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
