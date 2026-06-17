import { TickerChipInput } from "@/components/ticker-chip-input";

interface TickerShelfProps {
  tickers: string[];
  loadingTickers: Record<string, boolean>;
  onAdd: (ticker: string) => void;
  onRemove: (ticker: string) => void;
  /** When provided, filter from this list locally instead of calling the external search API. */
  suggestions?: string[];
}

export function TickerShelf({ tickers, loadingTickers, onAdd, onRemove, suggestions }: TickerShelfProps) {
  return (
    <TickerChipInput
      tickers={tickers}
      loadingTickers={loadingTickers}
      onAdd={onAdd}
      onRemove={onRemove}
      suggestions={suggestions}
      inputWidth="w-48"
      layout="inline"
    />
  );
}
