import { useState } from "react";
import { useSearchStocks, getSearchStocksQueryKey } from "@workspace/api-client-react";
import { Input } from "@/components/ui/input";
import { Search } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Command, CommandEmpty, CommandGroup, CommandItem, CommandList } from "@/components/ui/command";
import { useDebounce } from "@/hooks/use-debounce";

interface TickerInputProps {
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  id?: string;
}

export function TickerInput({ label, value, onChange, placeholder = "Enter ticker", id }: TickerInputProps) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState(value);
  const debouncedSearch = useDebounce(search, 300);

  const { data: searchResults, isLoading } = useSearchStocks(
    { q: debouncedSearch },
    { query: { enabled: debouncedSearch.length >= 2, queryKey: getSearchStocksQueryKey({ q: debouncedSearch }) } }
  );

  return (
    <div className="flex flex-col gap-2">
      <label className="text-xs font-semibold text-muted-foreground uppercase tracking-wider" htmlFor={id}>{label}</label>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <Input
              id={id}
              value={search}
              onChange={(e) => {
                setSearch(e.target.value.toUpperCase());
                setOpen(true);
              }}
              className="pl-9 h-12 text-lg font-mono uppercase bg-secondary/50 border-secondary focus-visible:ring-primary"
              placeholder={placeholder}
              data-testid={`input-ticker-${label.toLowerCase().replace(/\s+/g, '-')}`}
            />
          </div>
        </PopoverTrigger>
        <PopoverContent className="p-0 w-[300px]" align="start">
          <Command>
            <CommandList>
              {search.length < 2 && <div className="p-4 text-sm text-center text-muted-foreground">Type 2+ characters to search</div>}
              {search.length >= 2 && isLoading && <div className="p-4 text-sm text-center text-muted-foreground">Searching...</div>}
              {search.length >= 2 && !isLoading && searchResults?.length === 0 && (
                <CommandEmpty>No results found.</CommandEmpty>
              )}
              {searchResults && searchResults.length > 0 && (
                <CommandGroup heading="Results">
                  {searchResults.map((result) => (
                    <CommandItem
                      key={result.ticker}
                      value={result.ticker}
                      onSelect={(currentValue) => {
                        const ticker = currentValue.toUpperCase();
                        onChange(ticker);
                        setSearch(ticker);
                        setOpen(false);
                      }}
                      className="flex justify-between"
                    >
                      <span className="font-mono font-bold">{result.ticker}</span>
                      <span className="text-muted-foreground truncate ml-4">{result.name}</span>
                    </CommandItem>
                  ))}
                </CommandGroup>
              )}
            </CommandList>
          </Command>
        </PopoverContent>
      </Popover>
    </div>
  );
}
