// Global/sector movers sections (extracted from live.tsx).
import { cn } from "@/lib/utils";
import { pct, heatColor, heatBorderColor, formatVolume } from "./live-format";

export interface ScreenerMover {
  ticker: string;
  price: number | null;
  changePercent: number | null;
  volume: number | null;
}

export interface MoversResponse {
  global: { gainers: ScreenerMover[]; losers: ScreenerMover[]; mostActive: ScreenerMover[] };
}

function MoverRow({ m, showVolume }: { m: ScreenerMover; showVolume?: boolean }) {
  const up = (m.changePercent ?? 0) >= 0;
  return (
    <div
      className="flex items-center gap-2 px-2 py-1 text-xs border-l-2"
      style={{
        backgroundColor: heatColor(m.changePercent),
        borderLeftColor: heatBorderColor(m.changePercent),
      }}
    >
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
  );
}

export function MoverHeatmapGrid({
  title,
  movers,
  showVolume,
}: {
  title: string;
  movers: ScreenerMover[];
  showVolume?: boolean;
}) {
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
            <MoverRow key={m.ticker} m={m} showVolume={showVolume} />
          ))}
        </div>
      )}
    </div>
  );
}
