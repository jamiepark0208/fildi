// Compact "best strikes right now" table for the Live tab — top-N unique tickers
// from the options scanner's own scoring (see useTopOptions), following the page's
// dip/rally side: dip → sell puts, rally → sell calls.
import { cn } from "@/lib/utils";
import { useTopOptions } from "@/hooks/use-top-options";
import { useTickerTrackRecord } from "@/hooks/use-ticker-track-record";
import { CredibilityBadge } from "@/components/credibility-badge";
import { TickerRecordBadge } from "./ticker-record-badge";
import { scoreColor } from "./live-format";

const TH = "font-semibold text-[11px] uppercase tracking-wider px-3 py-1.5";

export function TopOptionsTable({ side, n = 7 }: { side: "put" | "call"; n?: number }) {
  const { rows, isFetching } = useTopOptions(side, n);
  const { data: tickerRecords } = useTickerTrackRecord();

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <span className="text-[11px] text-sky-300/60 font-mono">best strike per ticker · scanner scoring</span>
        <CredibilityBadge side={side} />
      </div>
      {rows.length === 0 ? (
        <p className="text-sm text-amber-200/40">
          {isFetching ? "Scoring option chains…" : "No scored candidates yet."}
        </p>
      ) : (
        <div className="rounded-md border border-[#d4af37]/25 overflow-hidden bg-zinc-950 shadow-lg shadow-black/60">
          <table className="w-full text-sm">
            <thead className="bg-black text-[#d4af37]">
              <tr className="border-b border-[#d4af37]/25">
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
            <tbody className="divide-y divide-zinc-800">
              {rows.map((r) => (
                <tr key={r.ticker} className="bg-zinc-900/70 even:bg-zinc-800/60 hover:bg-amber-500/10 transition-colors">
                  <td className="px-3 py-1.5 font-mono font-semibold text-white">
                    {r.ticker}
                    <TickerRecordBadge record={tickerRecords?.[r.ticker]?.[side]} />
                  </td>
                  <td className="px-3 py-1.5 text-right font-mono text-white">{r.spot.toFixed(2)}</td>
                  <td className="px-3 py-1.5 text-right font-mono text-amber-400">{r.strike.toFixed(2)}</td>
                  <td className="px-3 py-1.5 text-right font-mono text-sky-300/80">
                    {r.expiry.slice(5)} <span className="text-sky-300/50">· {r.dte}d</span>
                  </td>
                  <td className="px-3 py-1.5 text-right font-mono text-sky-300/80" title={r.bidIsLive ? "Live bid" : "Last session's bid (market closed)"}>
                    {r.bid.toFixed(2)}{!r.bidIsLive && <span className="text-amber-200/40">*</span>}
                  </td>
                  <td className="px-3 py-1.5 text-right font-mono text-green-400 font-semibold">{r.weeklyIncomePct.toFixed(2)}%</td>
                  <td className="px-3 py-1.5 text-right font-mono text-white">{r.otmPct.toFixed(1)}%</td>
                  <td className="px-3 py-1.5 text-right font-mono text-sky-300/80">{r.delta != null ? r.delta.toFixed(2) : "—"}</td>
                  <td className="px-3 py-1.5 text-right font-mono text-sky-300/80">{r.bufferSigmas != null ? `${r.bufferSigmas.toFixed(1)}σ` : "—"}</td>
                  <td className={cn("px-3 py-1.5 text-right font-mono font-semibold", scoreColor(r.optionScore))}>
                    {r.optionScore.toFixed(0)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
