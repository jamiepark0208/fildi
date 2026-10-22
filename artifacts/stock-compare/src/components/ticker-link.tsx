/**
 * Clickable ticker — opens the stock sheet (or custom handler). Hover warms breakdown cache.
 */
import type { ReactNode, MouseEvent } from "react";
import { cn } from "@/lib/utils";
import { useStockNavOptional } from "@/context/StockNavContext";

export function TickerLink({
  ticker,
  className,
  children,
  returnLabel,
  onClick,
  stopPropagation = true,
}: {
  ticker: string;
  className?: string;
  children?: ReactNode;
  /** Label on the sheet back button (e.g. "Rankings"). */
  returnLabel?: string;
  /** Override — e.g. watchlist in-pane select. Still gets hover prefetch when nav exists. */
  onClick?: (ticker: string) => void;
  stopPropagation?: boolean;
}) {
  const nav = useStockNavOptional();
  const t = ticker.trim().toUpperCase();

  return (
    <button
      type="button"
      className={cn(
        "font-mono font-bold text-white hover:text-[#d4af37] hover:underline underline-offset-2 decoration-[#d4af37]/50 transition-colors",
        className,
      )}
      onMouseEnter={() => nav?.prefetch(t)}
      onFocus={() => nav?.prefetch(t)}
      onClick={(e: MouseEvent) => {
        if (stopPropagation) e.stopPropagation();
        if (onClick) onClick(t);
        else nav?.open(t, { returnLabel });
      }}
    >
      {children ?? t}
    </button>
  );
}
