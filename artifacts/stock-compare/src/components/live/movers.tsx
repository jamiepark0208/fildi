// Global/sector movers sections (extracted from live.tsx).
import { cn } from "@/lib/utils";
import { pct, heatColor, heatBorderColor, formatVolume } from "./live-format";

export interface ScreenerMover {
  ticker: string;
  price: number | null;
  changePercent: number | null;
  volume: number | null;
}

export interface SectorMover {
  ticker: string;
  price: number;
  changePercent: number;
}

export interface SectorMoverGroup {
  sector: string;
  avgChangePercent: number;
  tickerCount: number;
  topGainers: SectorMover[];
  topLosers: SectorMover[];
}

export interface MoversResponse {
  global: { gainers: ScreenerMover[]; losers: ScreenerMover[]; mostActive: ScreenerMover[] };
  sectors: SectorMoverGroup[];
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

export function SectorMoverBars({ groups }: { groups: SectorMoverGroup[] }) {
  const maxAbs = Math.max(1, ...groups.map((g) => Math.abs(g.avgChangePercent)));
  return (
    <div className="space-y-1.5">
      {groups.map((g) => {
        const up = g.avgChangePercent >= 0;
        const widthPct = (Math.abs(g.avgChangePercent) / maxAbs) * 50;
        return (
          <div
            key={g.sector}
            className="rounded-lg border border-[#d4af37]/20 bg-zinc-950 px-3 py-2 hover:border-[#d4af37]/40 transition-colors"
          >
            <div className="flex items-center justify-between mb-1.5">
              <span className="text-sm font-medium text-white">{g.sector}</span>
              <span className="text-xs text-sky-300/70">{g.tickerCount} tickers</span>
              <span className={cn("text-sm font-bold font-mono", up ? "text-green-500" : "text-red-500")}>
                {pct(g.avgChangePercent)}
              </span>
            </div>

            <div className="relative h-1.5 rounded-full bg-zinc-800 overflow-hidden mb-2">
              <div className="absolute inset-y-0 left-1/2 w-px bg-zinc-700" />
              <div
                className={cn("absolute inset-y-0 rounded-full", up ? "bg-green-500" : "bg-red-500")}
                style={up ? { left: "50%", width: `${widthPct}%` } : { right: "50%", width: `${widthPct}%` }}
              />
            </div>

            <div className="flex flex-wrap gap-1">
              {g.topGainers.map((m) => (
                <span
                  key={`g-${m.ticker}`}
                  className="text-[11px] font-mono px-1.5 py-0.5 rounded text-green-400"
                  style={{ backgroundColor: heatColor(m.changePercent, 5) }}
                >
                  {m.ticker} {pct(m.changePercent)}
                </span>
              ))}
              {g.topLosers.map((m) => (
                <span
                  key={`l-${m.ticker}`}
                  className="text-[11px] font-mono px-1.5 py-0.5 rounded text-red-400"
                  style={{ backgroundColor: heatColor(m.changePercent, 5) }}
                >
                  {m.ticker} {pct(m.changePercent)}
                </span>
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}
