// Global/sector movers sections (extracted from live.tsx). A81 facts on |move|≥5% → row tooltip.
import { cn } from "@/lib/utils";
import { GRID_WRAP, GRID_HEADER, GRID_TH, gridRow } from "@/lib/score-explain-format";
import { pct, formatVolume } from "./live-format";

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
  const rows = movers.slice(0, 8);
  return (
    <div className={GRID_WRAP}>
      <div className={cn(GRID_HEADER, "px-2 py-1")}>
        <h3 className="text-[10px] font-semibold text-[#d4af37] uppercase tracking-widest">{title}</h3>
      </div>
      {rows.length === 0 ? (
        <p className="text-[10px] text-amber-200/40 px-2 py-1">No data.</p>
      ) : (
        <table className="w-full border-collapse text-[11px]">
          <thead>
            <tr className="border-b border-[#d4af37]/15 bg-black/60">
              <th className={cn(GRID_TH, "text-left py-0.5 px-2")}>Tkr</th>
              <th className={cn(GRID_TH, "text-right py-0.5 px-2")}>Price</th>
              <th className={cn(GRID_TH, "text-right py-0.5 px-2")}>Chg</th>
              {showVolume && <th className={cn(GRID_TH, "text-right py-0.5 px-2")}>Vol</th>}
            </tr>
          </thead>
          <tbody>
            {rows.map((m, i) => {
              const up = (m.changePercent ?? 0) >= 0;
              const fact = facts?.[m.ticker.toUpperCase()] ?? facts?.[m.ticker];
              const tip = [
                m.ticker,
                m.price != null ? `$${m.price.toFixed(2)}` : null,
                pct(m.changePercent),
                showVolume && m.volume != null ? `vol ${formatVolume(m.volume)}` : null,
                fact?.line || null,
              ].filter(Boolean).join(" · ");
              return (
                <tr
                  key={m.ticker}
                  className={cn(gridRow(i), "h-6")}
                  title={tip}
                >
                  <td className="py-0 px-2 font-mono font-bold text-white whitespace-nowrap leading-6">
                    {m.ticker}
                  </td>
                  <td className="py-0 px-2 text-right font-mono text-sky-300/80 tabular-nums whitespace-nowrap leading-6">
                    {m.price != null ? `$${m.price.toFixed(2)}` : "—"}
                  </td>
                  <td
                    className={cn(
                      "py-0 px-2 text-right font-mono font-semibold tabular-nums whitespace-nowrap leading-6",
                      up ? "text-green-500" : "text-red-500",
                    )}
                  >
                    {pct(m.changePercent)}
                  </td>
                  {showVolume && (
                    <td className="py-0 px-2 text-right font-mono text-amber-200/55 tabular-nums whitespace-nowrap leading-6">
                      {m.volume != null ? formatVolume(m.volume) : "—"}
                    </td>
                  )}
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </div>
  );
}
