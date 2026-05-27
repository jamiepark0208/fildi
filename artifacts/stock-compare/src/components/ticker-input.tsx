import { useState, useRef, useEffect, useCallback } from "react";
import { useSearchStocks, getSearchStocksQueryKey } from "@workspace/api-client-react";
import { Search, Loader2 } from "lucide-react";
import { useDebounce } from "@/hooks/use-debounce";
import { cn } from "@/lib/utils";

interface TickerInputProps {
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  id?: string;
}

export function TickerInput({ label, value, onChange, placeholder = "Enter ticker", id }: TickerInputProps) {
  const [inputText, setInputText] = useState(value);
  const [open, setOpen] = useState(false);
  const [focusedIndex, setFocusedIndex] = useState(-1);
  const inputRef = useRef<HTMLInputElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const closeTimeout = useRef<ReturnType<typeof setTimeout> | null>(null);

  const debouncedSearch = useDebounce(inputText, 180);

  const { data: results, isFetching } = useSearchStocks(
    { q: debouncedSearch },
    {
      query: {
        enabled: debouncedSearch.length >= 2,
        queryKey: getSearchStocksQueryKey({ q: debouncedSearch }),
        staleTime: 5 * 60 * 1000,
        gcTime: 10 * 60 * 1000,
      },
    }
  );

  const visibleResults = open && (results?.length ?? 0) > 0 ? results! : [];

  useEffect(() => {
    if (value !== inputText) {
      setInputText(value);
    }
  }, [value]);

  const selectTicker = useCallback((ticker: string, name: string) => {
    const upper = ticker.toUpperCase();
    setInputText(upper);
    onChange(upper);
    setOpen(false);
    setFocusedIndex(-1);
    inputRef.current?.blur();
  }, [onChange]);

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const val = e.target.value.toUpperCase();
    setInputText(val);
    onChange(val);
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
      if (e.key === "Enter") setOpen(false);
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
        selectTicker(r.ticker, r.name);
      } else {
        setOpen(false);
      }
    } else if (e.key === "Escape") {
      setOpen(false);
    }
  };

  const showDropdown = open && debouncedSearch.length >= 2;

  return (
    <div className="flex flex-col gap-2" ref={containerRef}>
      <label
        className="text-xs font-semibold text-muted-foreground uppercase tracking-wider"
        htmlFor={id}
      >
        {label}
      </label>
      <div className="relative">
        <Search className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground z-10" />
        {isFetching && debouncedSearch.length >= 2 && (
          <Loader2 className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground animate-spin z-10" />
        )}
        <input
          ref={inputRef}
          id={id}
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
          data-testid={`input-ticker-${label.toLowerCase().replace(/\s+/g, "-")}`}
          className={cn(
            "w-full h-12 pl-9 pr-10 text-lg font-mono uppercase rounded-md border bg-secondary/50 border-secondary",
            "text-foreground placeholder:text-muted-foreground/50",
            "focus:outline-none focus:ring-2 focus:ring-primary focus:border-primary",
            "transition-colors"
          )}
        />

        {showDropdown && (
          <div className="absolute top-full left-0 right-0 mt-1 z-50 rounded-md border border-border bg-card shadow-xl overflow-hidden">
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
                      selectTicker(r.ticker, r.name);
                    }}
                    className={cn(
                      "flex items-center justify-between px-4 py-2.5 cursor-pointer select-none",
                      "hover:bg-primary/10 transition-colors",
                      i === focusedIndex && "bg-primary/15"
                    )}
                    data-testid={`option-ticker-${r.ticker}`}
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
    </div>
  );
}
