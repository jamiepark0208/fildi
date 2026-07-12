import { useEffect, useState } from "react";
import { TrendingUp, TrendingDown, Minus } from "lucide-react";
import { cn } from "@/lib/utils";

interface MarketDataPoint {
  symbol: string;
  label: string;
  price: number | null;
  change: number | null;
  changePct: number | null;
}

function TickerChip({ point }: { point: MarketDataPoint }) {
  const isVix   = point.symbol === "^VIX";
  const hasData = point.price !== null;
  const up      = (point.changePct ?? 0) > 0;
  const down    = (point.changePct ?? 0) < 0;

  const chipColor = !hasData ? "text-muted-foreground"
    : isVix
      ? up ? "text-red-400" : down ? "text-green-400" : "text-foreground"
      : up ? "text-green-400" : down ? "text-red-400"  : "text-foreground";

  const Icon = !hasData ? Minus : up ? TrendingUp : TrendingDown;

  const pctStr = point.changePct !== null
    ? `${point.changePct > 0 ? "+" : ""}${point.changePct.toFixed(2)}%`
    : "";

  const priceStr = point.price !== null
    ? point.symbol === "^TNX"
      ? `${point.price.toFixed(2)}%`
      : point.price >= 1000 ? point.price.toFixed(0) : point.price.toFixed(2)
    : "—";

  return (
    <div className="flex items-center gap-2 px-3 whitespace-nowrap shrink-0">
      <span className="text-[10px] text-white/40 font-medium tracking-wide">{point.label}</span>
      <span className={cn("text-xs font-bold font-mono tabular-nums", chipColor)}>{priceStr}</span>
      {pctStr && (
        <span className={cn("text-[10px] font-mono flex items-center gap-0.5", chipColor)}>
          <Icon className="w-2.5 h-2.5" />{pctStr}
        </span>
      )}
      <span className="text-border/60 ml-1">·</span>
    </div>
  );
}

// Continuously scrolling one-row ticker tape — stays a single row at any window
// width because the content loops horizontally instead of wrapping.
export function MarketTickerBanner() {
  const [marketData, setMarketData] = useState<MarketDataPoint[]>([]);

  useEffect(() => {
    fetch("/api/daily-brief/market")
      .then(r => r.json())
      .then(d => setMarketData(d.marketData ?? []))
      .catch(() => {});
  }, []);

  if (marketData.length === 0) return null;

  return (
    <div className="rounded-xl border border-border bg-card overflow-hidden group">
      <div className="flex overflow-hidden">
        <div className="flex animate-marquee group-hover:animate-marquee-paused py-2">
          {marketData.map(pt => <TickerChip key={`a-${pt.symbol}`} point={pt} />)}
          {marketData.map(pt => <TickerChip key={`b-${pt.symbol}`} point={pt} />)}
        </div>
      </div>
    </div>
  );
}
