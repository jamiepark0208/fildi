// Compact "best strikes right now" table for the Live tab — top-N unique tickers
// from the options scanner's own scoring (see useTopOptions), following the page's
// dip/rally side: dip → sell puts, rally → sell calls.
import { cn } from "@/lib/utils";
import { useTopOptions } from "@/hooks/use-top-options";
import { scoreColor } from "./live-format";

const TH = "font-semibold text-[11px] uppercase tracking-wider px-3 py-1.5";

export function TopOptionsTable({ side, n = 7 }: { side: "put" | "call"; n?: number }) {
  const { rows, isFetching } = useTopOptions(side, n);
  const title = side === "call" ? "Top Calls to Sell" : "Top Puts to Sell";

  return (
    <section className="space-y-2">
      <div className="flex items-center gap-2">
        <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide">{title}</h2>
        <span className="text-[11px] text-zinc-500 font-mono">best strike per ticker · scanner scoring</span>
      </div>
      {rows.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          {isFetching ? "Scoring option chains…" : "No scored candidates yet."}
        </p>
      ) : (
        <div className="rounded-md border border-zinc-600/40 overflow-hidden bg-zinc-900/70 shadow-lg shadow-black/40">
          <table className="w-full text-sm">
            <thead className="bg-zinc-800/90 text-white">
              <tr className="border-b border-zinc-600/40">
                <th className={cn(TH, "text-left")}>Ticker</th>
                <th className={cn(TH, "text-right")}>Price</th>
                <th className={cn(TH, "text-right")}>Strike</th>
                <th className={cn(TH, "text-right")}>Exp / DTE</th>
                <th className={cn(TH, "text-right")}>Bid</th>
                <th className={cn(TH, "text-right")}>%/wk</th>
                <th className={cn(TH, "text-right")}>OTM%</th>
                <th className={cn(TH, "text-right")}>Δ</th>
                <th className={cn(TH, "text-right")}>Buffer</th>
                <th className={cn(TH, "text-right")}>Score</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.ticker} className="bg-zinc-900/40 even:bg-zinc-800/40 hover:bg-zinc-700/50 transition-colors">
                  <td className="px-3 py-1.5 font-mono font-semibold text-white">{r.ticker}</td>
                  <td className="px-3 py-1.5 text-right font-mono text-white">{r.spot.toFixed(2)}</td>
                  <td className="px-3 py-1.5 text-right font-mono text-amber-400">{r.strike.toFixed(2)}</td>
                  <td className="px-3 py-1.5 text-right font-mono text-zinc-300">
                    {r.expiry.slice(5)} <span className="text-zinc-500">· {r.dte}d</span>
                  </td>
                  <td className="px-3 py-1.5 text-right font-mono text-zinc-300" title={r.bidIsLive ? "Live bid" : "Last session's bid (market closed)"}>
                    {r.bid.toFixed(2)}{!r.bidIsLive && <span className="text-zinc-500">*</span>}
                  </td>
                  <td className="px-3 py-1.5 text-right font-mono text-green-400 font-semibold">{r.weeklyIncomePct.toFixed(2)}%</td>
                  <td className="px-3 py-1.5 text-right font-mono text-white">{r.otmPct.toFixed(1)}%</td>
                  <td className="px-3 py-1.5 text-right font-mono text-zinc-300">{r.delta != null ? r.delta.toFixed(2) : "—"}</td>
                  <td className="px-3 py-1.5 text-right font-mono text-zinc-300">{r.bufferSigmas != null ? `${r.bufferSigmas.toFixed(1)}σ` : "—"}</td>
                  <td className={cn("px-3 py-1.5 text-right font-mono font-semibold", scoreColor(r.optionScore))}>
                    {r.optionScore.toFixed(0)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
