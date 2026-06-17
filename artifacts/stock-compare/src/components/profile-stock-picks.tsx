import { useState, useEffect } from "react";
import { TickerChipInput } from "@/components/ticker-chip-input";
import { cn } from "@/lib/utils";

export interface StockPicksData {
  bullish: string[];
  neutral: string[];
  bearish: string[];
}

type Stance = keyof StockPicksData;

const STANCE_CONFIG: Record<
  Stance,
  { label: string; border: string; title: string }
> = {
  bullish: {
    label: "Bullish",
    title: "text-green-400",
    border: "border-green-500/30 bg-green-500/5",
  },
  neutral: {
    label: "Neutral",
    title: "text-yellow-400",
    border: "border-yellow-500/30 bg-yellow-500/5",
  },
  bearish: {
    label: "Bearish",
    title: "text-red-400",
    border: "border-red-500/30 bg-red-500/5",
  },
};

interface ProfileStockPicksProps {
  picks: StockPicksData;
  isOwner: boolean;
  suggestions?: string[];
  onSave: (picks: StockPicksData) => Promise<void>;
}

export function ProfileStockPicks({
  picks,
  isOwner,
  suggestions,
  onSave,
}: ProfileStockPicksProps) {
  const [local, setLocal] = useState(picks);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setLocal(picks);
  }, [picks]);

  async function persist(next: StockPicksData) {
    const prev = local;
    setLocal(next);
    if (!isOwner) return;
    setSaving(true);
    setError(null);
    try {
      await onSave(next);
    } catch (e) {
      setLocal(prev);
      setError(e instanceof Error ? e.message : "Failed to save picks");
    } finally {
      setSaving(false);
    }
  }

  function handleAdd(stance: Stance, ticker: string) {
    if (local[stance].includes(ticker)) return;
    if (local[stance].length >= 5) return;
    void persist({ ...local, [stance]: [...local[stance], ticker] });
  }

  function handleRemove(stance: Stance, ticker: string) {
    void persist({ ...local, [stance]: local[stance].filter((t) => t !== ticker) });
  }

  return (
    <section className="space-y-3">
      <div>
        <h2 className="text-base font-bold text-foreground tracking-tight">Stock Picks</h2>
        <p className="text-xs text-muted-foreground mt-0.5">
          Your public stock picks — separate from Fundamental/Technical compare slots.
        </p>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        {(Object.keys(STANCE_CONFIG) as Stance[]).map((stance) => {
          const cfg = STANCE_CONFIG[stance];
          return (
            <div
              key={stance}
              className={cn(
                "rounded-lg border p-3 space-y-2 min-h-[120px]",
                cfg.border,
              )}
            >
              <div className="flex items-center justify-between gap-2">
                <span className={cn("text-sm font-semibold", cfg.title)}>{cfg.label}</span>
                {isOwner && saving && (
                  <span className="text-[10px] text-muted-foreground animate-pulse">Saving…</span>
                )}
              </div>
              <TickerChipInput
                tickers={local[stance]}
                onAdd={(t) => handleAdd(stance, t)}
                onRemove={(t) => handleRemove(stance, t)}
                suggestions={suggestions}
                readOnly={!isOwner}
                maxTickers={5}
                layout="stacked"
                placeholder="Add ticker…"
              />
            </div>
          );
        })}
      </div>

      {error && <p className="text-xs text-red-400">{error}</p>}
    </section>
  );
}
