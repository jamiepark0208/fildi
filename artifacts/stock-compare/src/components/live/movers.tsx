// Global/sector movers sections (extracted from live.tsx). A81 facts on |move|≥5% → DataTip.
import { cn } from "@/lib/utils";
import { GRID_WRAP, GRID_HEADER, GRID_TH, gridRow } from "@/lib/score-explain-format";
import { DataTip } from "@/components/data-tip";
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
  onTickerClick,
}: {
  title: string;
  movers: ScreenerMover[];
  showVolume?: boolean;
  facts?: Record<string, MoverFactLine>;
  /** Click row → parent Live session chart. */
  onTickerClick?: (ticker: string) => void;
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
                "Live movers · Yahoo screener (session)",
                m.ticker,
                m.price != null ? `$${m.price.toFixed(2)}` : null,
                pct(m.changePercent),
                showVolume && m.volume != null ? `vol ${formatVolume(m.volume)}` : null,
                fact?.line || null,
                onTickerClick ? "click → session chart" : null,
              ].filter(Boolean).join(" · ");
              return (
                <tr
                  key={m.ticker}
                  className={cn(
                    gridRow(i),
                    "h-6",
                    onTickerClick && "cursor-pointer hover:bg-amber-500/15",
                  )}
                  onClick={onTickerClick ? () => onTickerClick(m.ticker.toUpperCase()) : undefined}
                >
                  <td className="py-0 px-2 font-mono font-bold text-white whitespace-nowrap leading-6">
                    <DataTip tip={tip}>{m.ticker}</DataTip>
                  </td>
                  <td
                    className={cn(
                      "py-0 px-2 text-right font-mono font-semibold tabular-nums whitespace-nowrap leading-6",
                      up ? "text-green-500" : "text-red-500",
                    )}
                  >
                    <DataTip tip={tip}>
                      {m.price != null
                        ? `$${m.price.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
                        : "—"}
                    </DataTip>
                  </td>
                  <td
                    className={cn(
                      "py-0 px-2 text-right font-mono font-semibold tabular-nums whitespace-nowrap leading-6",
                      up ? "text-green-500" : "text-red-500",
                    )}
                  >
                    <DataTip tip={tip}>{pct(m.changePercent)}</DataTip>
                  </td>
                  {showVolume && (
                    <td className="py-0 px-2 text-right font-mono text-amber-50/90 tabular-nums whitespace-nowrap leading-6">
                      <DataTip tip={tip}>
                        {m.volume != null ? formatVolume(m.volume) : "—"}
                      </DataTip>
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
