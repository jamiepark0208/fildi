// Detail sub-tabs of PortfolioAnalysis: Top Tickers, Cumulative Summary, Correlation, Options Income.
import { Cell, BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid } from "recharts";
import { CardContent } from "@/components/ui/card";
import { formatCurrency, formatCompactCurrency } from "@/lib/format";
import { cn } from "@/lib/utils";
import { TTH, TTD, isSameUnderlyingPair, correlationBg } from "./portfolio-palette";
import type { buildTopTickersByAccount, buildCumulativeSummaryByAccount, buildOptionsIncomeTimeline } from "./portfolio-pnl-calc";
import type { PortfolioRiskResult } from "./portfolio-risk-calc";

/** Dense correlation cells — grid stretches to fill the detail card. */
const CORR_TH = "p-0 text-[8px] font-bold uppercase tracking-tight text-white text-center leading-none align-middle";
const CORR_TD = "p-0 text-[9px] tabular-nums text-center leading-none align-middle";

type TopTickerRow = ReturnType<typeof buildTopTickersByAccount>["All"][number];
type SummaryRow = ReturnType<typeof buildCumulativeSummaryByAccount>["All"][number];

export function TopTickersPanel({ rows }: { rows: TopTickerRow[] }) {
  return (
      <CardContent className="px-0 pb-0">
        {rows.length === 0 ? (
          <div className="h-[60px] flex items-center justify-center text-xs text-white">
            No trades closed this year yet
          </div>
        ) : (
          <table className="w-full">
            <thead>
              <tr className="border-y border-[#d4af37]/15 bg-secondary/20">
                <th className={TTH}>#</th>
                <th className={cn(TTH, "text-left")}>Ticker</th>
                <th className={cn(TTH, "text-right")}>Puts Sold</th>
                <th className={cn(TTH, "text-right")}>Calls Sold</th>
                <th className={cn(TTH, "text-right")}>Stock Sales</th>
                <th className={cn(TTH, "text-right")}>Times Traded</th>
                <th className={cn(TTH, "text-right")}>Net Realized P&amp;L YTD</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((t, i) => (
                <tr key={t.symbol} className={cn("border-b border-border/20 hover:bg-secondary/10 transition-colors", i % 2 === 0 ? "" : "bg-secondary/5")}>
                  <td className={cn(TTD, "text-white")}>{i + 1}</td>
                  <td className={cn(TTD, "text-left font-bold")}>{t.symbol}</td>
                  <td className={cn(TTD, "text-right text-white")}>{t.puts || "—"}</td>
                  <td className={cn(TTD, "text-right text-white")}>{t.calls || "—"}</td>
                  <td className={cn(TTD, "text-right text-white")}>{t.stockSales || "—"}</td>
                  <td className={cn(TTD, "text-right text-white")}>{t.count}</td>
                  <td className={cn(TTD, "text-right font-semibold",
                    t.netPnl > 0 ? "text-green-400" : t.netPnl < 0 ? "text-red-400" : "text-white")}>
                    {t.netPnl >= 0 ? "+" : ""}{formatCurrency(t.netPnl)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </CardContent>
  );
}

export function CumulativeSummaryPanel({ rows }: { rows: SummaryRow[] }) {
  return (
      <CardContent className="px-0 pb-0">
        {rows.length === 0 ? (
          <div className="h-[60px] flex items-center justify-center text-xs text-white">
            No activity for this account yet
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="border-y border-[#d4af37]/15 bg-secondary/20">
                  <th className={cn(TTH, "text-left")}>Ticker</th>
                  <th className={cn(TTH, "text-right")}>Unrealized</th>
                  <th className={cn(TTH, "text-right")}>Realized</th>
                  <th className={cn(TTH, "text-right")}>Earned</th>
                  <th className={cn(TTH, "text-right")}>Sell Put</th>
                  <th className={cn(TTH, "text-right")}>Sell Call</th>
                  <th className={cn(TTH, "text-right")}>Long Call</th>
                  <th className={cn(TTH, "text-right")}>Long Put</th>
                  <th className={cn(TTH, "text-right")}>Dividends</th>
                  <th className={cn(TTH, "text-right")}>Stocks Realized</th>
                  <th className={cn(TTH, "text-right")}>Stocks Unrealized</th>
                  <th className={cn(TTH, "text-right")}>Total Stocks</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r, i) => {
                  const cell = (v: number) => (
                    <td className={cn(TTD, "text-right", v > 0 ? "text-green-400" : v < 0 ? "text-red-400" : "text-white")}>
                      {v !== 0 ? `${v >= 0 ? "+" : ""}${formatCurrency(v)}` : "—"}
                    </td>
                  );
                  return (
                    <tr key={r.ticker} className={cn("border-b border-border/20 hover:bg-secondary/10 transition-colors", i % 2 === 0 ? "" : "bg-secondary/5")}>
                      <td className={cn(TTD, "text-left font-bold")}>{r.ticker}</td>
                      {cell(r.totalUnrealized)}
                      {cell(r.totalRealized)}
                      <td className={cn(TTD, "text-right font-bold", r.totalEarned > 0 ? "text-green-400" : r.totalEarned < 0 ? "text-red-400" : "text-white")}>
                        {r.totalEarned >= 0 ? "+" : ""}{formatCurrency(r.totalEarned)}
                      </td>
                      {cell(r.sellPut)}
                      {cell(r.sellCall)}
                      {cell(r.longCall)}
                      {cell(r.longPut)}
                      {cell(r.dividends)}
                      <td
                        className={cn(TTD, "text-right", r.stocksRealized > 0 ? "text-green-400" : r.stocksRealized < 0 ? "text-red-400" : "text-white")}
                        title={r.stocksRealizedMixed ? "Export vs transactions disagree on sign — kept export" : undefined}
                      >
                        {r.stocksRealized !== 0
                          ? `${r.stocksRealized >= 0 ? "+" : ""}${formatCurrency(r.stocksRealized)}${r.stocksRealizedMixed ? "*" : ""}`
                          : "—"}
                      </td>
                      {cell(r.stocksUnrealized)}
                      {cell(r.totalStocks)}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </CardContent>
  );
}

export function CorrelationPanel({ risk, scaleMax }: { risk: PortfolioRiskResult | null | undefined; scaleMax: number }) {
  return (
      <CardContent className="px-2 pb-2 pt-1">
        {!risk || risk.tickers.length < 2 ? (
          <div className="h-[200px] flex items-center justify-center text-xs text-white">
            Need price history on at least two names for a correlation matrix
          </div>
        ) : (
          (() => {
            const n = risk.tickers.length;
            const labelPct = Math.max(4.5, Math.min(8, 100 / (n + 2)));
            const cellPct = (100 - labelPct) / n;
            return (
              <div className="w-full" style={{ height: `min(62vh, ${Math.max(280, (n + 1) * 22)}px)` }}>
                <table className="w-full h-full border-collapse table-fixed">
                  <colgroup>
                    <col style={{ width: `${labelPct}%` }} />
                    {risk.tickers.map((t) => (
                      <col key={t} style={{ width: `${cellPct}%` }} />
                    ))}
                  </colgroup>
                  <thead>
                    <tr className="border-y border-[#d4af37]/15 bg-secondary/20" style={{ height: `${100 / (n + 1)}%` }}>
                      <th className={cn(CORR_TH, "sticky left-0 bg-zinc-950 z-[1]")} />
                      {risk.tickers.map((t) => (
                        <th key={t} className={cn(CORR_TH, "truncate")} title={t}>
                          {t.length > 4 ? t.slice(0, 4) : t}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {risk.tickers.map((rowTicker, i) => (
                      <tr
                        key={rowTicker}
                        className={cn("border-b border-border/15", i % 2 === 0 ? "" : "bg-secondary/5")}
                        style={{ height: `${100 / (n + 1)}%` }}
                      >
                        <td
                          className={cn(CORR_TD, "sticky left-0 bg-zinc-950 z-[1] text-left font-bold text-zinc-200 pl-1 truncate")}
                          title={rowTicker}
                        >
                          {rowTicker.length > 4 ? rowTicker.slice(0, 4) : rowTicker}
                        </td>
                        {risk.correlationMatrix[i].map((v, j) => {
                          const colTicker = risk.tickers[j];
                          const isDiagonal = i === j;
                          const isExcluded = isSameUnderlyingPair(rowTicker, colTicker);
                          if (isDiagonal || isExcluded) {
                            return (
                              <td
                                key={j}
                                className={cn(CORR_TD, "text-white")}
                                title={isExcluded ? "Same underlying — excluded from color scale" : undefined}
                              >
                                {v.toFixed(1)}
                              </td>
                            );
                          }
                          return (
                            <td
                              key={j}
                              className={cn(CORR_TD, "font-semibold text-white")}
                              style={{ backgroundColor: correlationBg(v, scaleMax) }}
                              title={`${rowTicker}×${colTicker}: ${v.toFixed(3)}`}
                            >
                              {v.toFixed(1)}
                            </td>
                          );
                        })}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            );
          })()
        )}
      </CardContent>
  );
}

export function OptionsIncomePanel({ timeline }: { timeline: ReturnType<typeof buildOptionsIncomeTimeline> }) {
  return (
      <CardContent className="px-4 pb-4">
        {timeline.chartData.length === 0 ? (
          <div className="h-[220px] flex items-center justify-center text-xs text-white">No data</div>
        ) : (
          <ResponsiveContainer width="100%" height={220}>
            <BarChart data={timeline.chartData} barSize={12} margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" vertical={false} opacity={0.4} />
              <XAxis dataKey="label" interval={2} tick={{ fontSize: 10, fill: "#ffffff" }} axisLine={false} tickLine={false} />
              <YAxis tick={{ fontSize: 11, fill: "#ffffff" }} axisLine={false} tickLine={false} width={40} tickFormatter={(v) => formatCompactCurrency(v)} />
              <Tooltip content={(p) => {
                const d = p.payload?.[0]?.payload;
                if (!p.active || !d) return null;
                return (
                  <div className="bg-popover border border-border rounded-lg p-2.5 shadow-xl text-xs space-y-1 text-white">
                    <div className="font-semibold">{d.label}{d.isFuture ? " (projected)" : ""}</div>
                    {d.isFuture ? (
                      <div className="flex justify-between gap-4"><span className="text-white">Projected</span><span className="font-mono font-semibold">{formatCurrency(d.projected)}</span></div>
                    ) : (
                      <div className="flex justify-between gap-4"><span className="text-white">Earned</span><span className="font-mono font-semibold">{formatCurrency(d.actual)}</span></div>
                    )}
                  </div>
                );
              }} cursor={{ fill: "hsl(var(--secondary))", opacity: 0.5 }} />
              <Bar dataKey="actual" stackId="income" radius={[2, 2, 0, 0]}>
                {timeline.chartData.map((d, i) => (
                  <Cell key={i} fill={d.actual >= 0 ? "#34d399" : "#f87171"} />
                ))}
              </Bar>
              <Bar dataKey="projected" stackId="income" radius={[2, 2, 0, 0]} fill="#38bdf8" fillOpacity={0.35} />
            </BarChart>
          </ResponsiveContainer>
        )}
        <div className="mt-3 pt-3 border-t border-[#d4af37]/15 flex flex-wrap gap-x-4 gap-y-1.5">
          {[
            { color: "#34d399", label: "Earned (actual)" },
            { color: "#f87171", label: "Loss (actual)" },
            { color: "rgba(56,189,248,0.35)", label: "Projected (run-rate)" },
          ].map(({ color, label }) => (
            <div key={label} className="flex items-center gap-1.5 text-[10px] text-white">
              <div className="w-2 h-2 rounded-full shrink-0" style={{ background: color }} />
              {label}
            </div>
          ))}
        </div>
      </CardContent>
  );
}
