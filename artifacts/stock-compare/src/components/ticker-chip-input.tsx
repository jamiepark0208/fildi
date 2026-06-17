import { useState, useRef, useCallback } from "react";
import { useSearchStocks, getSearchStocksQueryKey } from "@workspace/api-client-react";
import { Search, Loader2, X } from "lucide-react";
import { useDebounce } from "@/hooks/use-debounce";
import { cn } from "@/lib/utils";

export interface TickerChipInputProps {
  tickers: string[];
  onAdd: (ticker: string) => void;
  onRemove: (ticker: string) => void;
  /** Filter from this list locally instead of calling search API */
  suggestions?: string[];
  readOnly?: boolean;
  maxTickers?: number;
  placeholder?: string;
  inputWidth?: string;
  loadingTickers?: Record<string, boolean>;
  layout?: "inline" | "stacked";
}

export function TickerChipInput({
  tickers,
  onAdd,
  onRemove,
  suggestions,
  readOnly = false,
  maxTickers = 5,
  placeholder = "Add ticker, AAPL, MSFT…",
  inputWidth = "w-full",
  loadingTickers = {},
  layout = "inline",
}: TickerChipInputProps) {
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
        enabled: !readOnly && !suggestions && debouncedSearch.length >= 2,
        queryKey: getSearchStocksQueryKey({ q: debouncedSearch }),
        staleTime: 5 * 60 * 1000,
        gcTime: 10 * 60 * 1000,
      },
    },
  );

  const results = suggestions
    ? debouncedSearch.length >= 1
      ? suggestions
          .filter((t) => t.includes(debouncedSearch) && !tickers.includes(t))
          .map((t) => ({ ticker: t, name: t, exchange: "", type: "EQUITY" }))
      : []
    : (apiResults ?? []);

  const visibleResults = open && results.length > 0 ? results : [];

  const selectTicker = useCallback(
    (ticker: string) => {
      const upper = ticker.toUpperCase().trim();
      if (upper && !tickers.includes(upper) && tickers.length < maxTickers) {
        onAdd(upper);
      }
      setInputText("");
      setOpen(false);
      setFocusedIndex(-1);
      setTimeout(() => inputRef.current?.focus(), 0);
    },
    [maxTickers, onAdd, tickers],
  );

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const val = e.target.value.toUpperCase();
    if (val.includes(",")) {
      const parts = val.split(",");
      const toAdd = parts.slice(0, -1).map((t) => t.trim()).filter(Boolean);
      for (const t of toAdd) {
        if (tickers.length >= maxTickers) break;
        onAdd(t);
      }
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
    if (inputText.length >= 1) setOpen(true);
  };

  const handleBlur = () => {
    closeTimeout.current = setTimeout(() => setOpen(false), 150);
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (!open || visibleResults.length === 0) {
      if (e.key === "Enter" && inputText.trim()) {
        e.preventDefault();
        const parts = inputText.split(",").map((t) => t.trim()).filter(Boolean);
        if (parts.length > 1) {
          for (const t of parts) {
            if (tickers.length >= maxTickers) break;
            onAdd(t.toUpperCase());
          }
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
      setFocusedIndex((i) => Math.min(i + 1, visibleResults.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setFocusedIndex((i) => Math.max(i - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (focusedIndex >= 0 && visibleResults[focusedIndex]) {
        selectTicker(visibleResults[focusedIndex].ticker);
      } else if (inputText.trim()) {
        selectTicker(inputText.trim());
      } else {
        setOpen(false);
      }
    } else if (e.key === "Escape") {
      setOpen(false);
    }
  };

  const showDropdown = !readOnly && open && debouncedSearch.length >= (suggestions ? 1 : 2);
  const isAtLimit = tickers.length >= maxTickers;

  return (
    <div
      ref={containerRef}
      className={cn(
        layout === "stacked" ? "flex flex-col gap-2" : "flex flex-wrap items-center gap-2",
      )}
    >
      <div className={cn("flex flex-wrap gap-1.5", layout === "stacked" && "min-h-[28px]")}>
        {tickers.map((ticker) => (
          <div
            key={ticker}
            className="flex items-center gap-1.5 px-2.5 py-1 bg-secondary text-secondary-foreground rounded-full text-sm font-bold shadow-sm"
          >
            {loadingTickers[ticker] ? (
              <Loader2 className="w-3.5 h-3.5 animate-spin text-muted-foreground" />
            ) : (
              <span className="font-mono tracking-tight text-foreground">{ticker}</span>
            )}
            {!readOnly && (
              <button
                type="button"
                onClick={() => onRemove(ticker)}
                className="hover:bg-background/20 rounded-full p-0.5 transition-colors"
                title="Remove ticker"
              >
                <X className="w-3 h-3" />
              </button>
            )}
          </div>
        ))}
        {tickers.length === 0 && readOnly && (
          <span className="text-xs text-muted-foreground italic">No picks yet</span>
        )}
      </div>

      {!readOnly && !isAtLimit && (
        <div className={cn("relative", inputWidth)}>
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
            placeholder={placeholder}
            className={cn(
              "w-full h-8 pl-8 pr-8 text-sm font-mono uppercase rounded-full border border-border bg-card",
              "text-foreground placeholder:text-muted-foreground/50",
              "focus:outline-none focus:ring-1 focus:ring-primary focus:border-primary",
              "transition-colors",
            )}
          />

          {showDropdown && (
            <div className="absolute top-full left-0 right-0 min-w-[200px] mt-1 z-50 rounded-md border border-border bg-card shadow-xl overflow-hidden">
              {isFetching && (!results || results.length === 0) ? (
                <div className="px-4 py-3 text-sm text-muted-foreground flex items-center gap-2">
                  <Loader2 className="h-3 w-3 animate-spin" /> Searching...
                </div>
              ) : visibleResults.length === 0 ? (
                <div className="px-4 py-3 text-sm text-muted-foreground">
                  No results for &quot;{debouncedSearch}&quot;
                </div>
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
                        i === focusedIndex && "bg-primary/15",
                      )}
                    >
                      <span className="font-mono font-bold text-foreground">{r.ticker}</span>
                      <span className="text-muted-foreground text-sm truncate ml-4 max-w-[160px]">
                        {r.name}
                      </span>
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
