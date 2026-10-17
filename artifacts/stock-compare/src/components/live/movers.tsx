// Global/sector movers sections (extracted from live.tsx). A81 facts on |move|≥5%.
import { useMemo, useState } from "react";
import { cn } from "@/lib/utils";
import { pct, heatColor, heatBorderColor, formatVolume } from "./live-format";

export interface ScreenerMover {
  ticker: string;
  price: number | null;
  changePercent: number | null;
  volume: number | null;
}

export type MoverFactLine = {
  line: string;
  movePct: number | null;
  driver: string;
  driverDetail: string | null;
};

export interface MoversResponse {
  global: { gainers: ScreenerMover[]; losers: ScreenerMover[]; mostActive: ScreenerMover[] };
  facts?: Record<string, MoverFactLine>;
}

function dismissKey(): string {
  return `mover-facts-dismissed:${new Date().toISOString().slice(0, 10)}`;
}

function loadDismissed(): Set<string> {
  try {
    const raw = localStorage.getItem(dismissKey());
    return new Set(raw ? (JSON.parse(raw) as string[]) : []);
  } catch {
    return new Set();
  }
}

function saveDismissed(s: Set<string>) {
  localStorage.setItem(dismissKey(), JSON.stringify([...s]));
}

function MoverRow({
  m,
  showVolume,
  fact,
  dismissed,
  onDismiss,
}: {
  m: ScreenerMover;
  showVolume?: boolean;
  fact?: MoverFactLine;
  dismissed: boolean;
  onDismiss: () => void;
}) {
  const up = (m.changePercent ?? 0) >= 0;
  const showFact = !!fact?.line && !dismissed && m.changePercent != null && Math.abs(m.changePercent) >= 5;
  return (
    <div
      className="px-2 py-1 text-xs border-l-2"
      style={{
        backgroundColor: heatColor(m.changePercent),
        borderLeftColor: heatBorderColor(m.changePercent),
      }}
    >
      <div className="flex items-center gap-2">
        <span className="font-mono font-bold text-white w-14 shrink-0">{m.ticker}</span>
        <span className="text-sky-300/70 w-16 shrink-0">
          {m.price != null ? `$${m.price.toFixed(2)}` : "—"}
        </span>
        <span className={cn("font-bold w-14 shrink-0", up ? "text-green-500" : "text-red-500")}>
          {pct(m.changePercent)}
        </span>
        {showVolume && (
          <span className="text-amber-200/50 ml-auto">
            {m.volume != null ? formatVolume(m.volume) : "—"}
          </span>
        )}
      </div>
      {showFact && (
        <div className="mt-0.5 flex items-start gap-1 text-[10px] text-amber-100/70 leading-snug">
          <span className="flex-1 min-w-0" title="Facts only — no sell/wait take (A81)">{fact.line}</span>
          <button
            type="button"
            className="shrink-0 text-amber-200/40 hover:text-amber-100"
            title="Dismiss today"
            onClick={(e) => { e.stopPropagation(); onDismiss(); }}
          >
            ×
          </button>
        </div>
      )}
    </div>
  );
}

export function MoverHeatmapGrid({
  title,
  movers,
  showVolume,
  facts,
}: {
  title: string;
  movers: ScreenerMover[];
  showVolume?: boolean;
  facts?: Record<string, MoverFactLine>;
}) {
  const [dismissed, setDismissed] = useState(() => loadDismissed());
  const gone = useMemo(() => dismissed, [dismissed]);
  return (
    <div className="rounded-lg border border-[#d4af37]/20 overflow-hidden bg-zinc-950">
      <h3 className="text-xs font-semibold text-[#d4af37] uppercase tracking-wide bg-black px-2 py-1 border-b border-[#d4af37]/20">
        {title}
      </h3>
      {movers.length === 0 ? (
        <p className="text-xs text-amber-200/40 p-2">No data.</p>
      ) : (
        <div className="divide-y divide-zinc-800">
          {movers.slice(0, 8).map((m) => (
            <MoverRow
              key={m.ticker}
              m={m}
              showVolume={showVolume}
              fact={facts?.[m.ticker.toUpperCase()] ?? facts?.[m.ticker]}
              dismissed={gone.has(m.ticker.toUpperCase())}
              onDismiss={() => {
                const next = new Set(gone);
                next.add(m.ticker.toUpperCase());
                saveDismissed(next);
                setDismissed(next);
              }}
            />
          ))}
        </div>
      )}
    </div>
  );
}
