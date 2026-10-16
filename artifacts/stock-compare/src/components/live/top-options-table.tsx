// Compact "best strikes right now" table for the Live tab — top-N unique tickers
// from the options scanner's own scoring (see useTopOptions), following the page's
// dip/rally side: dip → sell puts, rally → sell calls.
import { cn } from "@/lib/utils";
import { useTopOptions } from "@/hooks/use-top-options";
import { useTickerTrackRecord } from "@/hooks/use-ticker-track-record";
import { CredibilityBadge } from "@/components/credibility-badge";
import { TickerRecordBadge } from "./ticker-record-badge";
import { scoreColor } from "./live-format";
import { RecConflictChip } from "./rec-conflict-chip";
import type { RecConflict } from "@/lib/rec-conflicts";

/** Match Track Record compact density */
const TH = "font-semibold text-[9px] uppercase tracking-wider px-1.5 py-0.5";
const TD = "px-1.5 py-0.5 text-[11px] font-mono";

export function TopOptionsTable({
  side,
  n = 7,
  regimeDirection = null,
  regimeConfidence = null,
  conflictsByTicker,
}: {
  side: "put" | "call";
  n?: number;
  regimeDirection?: "bullish" | "bearish" | "mixed" | null;
  regimeConfidence?: number | null;
  conflictsByTicker?: Map<string, RecConflict[]>;
}) {
  const { rows, isFetching } = useTopOptions(side, n);
  const { data: tickerRecords } = useTickerTrackRecord();

  const softCaution =
    regimeConfidence != null &&
    regimeConfidence >= 60 &&
    ((side === "put" && regimeDirection === "bearish") ||
      (side === "call" && regimeDirection === "bullish"));

  return (
    <div className="space-y-1.5">
      <div className="flex items-center gap-2 flex-wrap px-0.5">
        <span className="text-[10px] text-sky-300/60 font-mono">best strike / ticker · scanner</span>
        <CredibilityBadge side={side} />
      </div>
      {softCaution && (
        <p className="text-[10px] text-amber-300/80 border border-amber-500/25 rounded px-1.5 py-0.5 bg-amber-500/5">
          Regime {regimeDirection} ({regimeConfidence}%) — soft caution on sell-{side}s.
        </p>
      )}
      {rows.length === 0 ? (
        <p className="text-[11px] text-amber-200/40">
          {isFetching ? "Scoring option chains…" : "No scored candidates yet."}
        </p>
      ) : (
        <div className="rounded-md border border-[#d4af37]/20 overflow-hidden bg-zinc-950">
          <table className="w-full">
            <thead className="bg-black text-[#d4af37]">
              <tr className="border-b border-[#d4af37]/20">
                <th className={cn(TH, "text-left")}>Ticker</th>
                <th className={cn(TH, "text-right")}>Px</th>
                <th className={cn(TH, "text-right")}>Strike</th>
                <th className={cn(TH, "text-right")}>Exp</th>
                <th className={cn(TH, "text-right")}>Bid</th>
                <th className={cn(TH, "text-right")}>%/wk</th>
                <th className={cn(TH, "text-right")}>OTM</th>
                <th className={cn(TH, "text-right")}>Δ</th>
                <th className={cn(TH, "text-right")}>Buf</th>
                <th className={cn(TH, "text-right")}>Scr</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-800/80">
              {rows.map((r) => (
                <tr key={r.ticker} className="bg-zinc-900/60 even:bg-zinc-900/30 hover:bg-amber-500/10 transition-colors">
                  <td className={cn(TD, "font-semibold text-white")}>
                    {r.ticker}
                    <TickerRecordBadge record={tickerRecords?.[r.ticker]?.[side]} livePrice={r.spot} side={side} />
                    <RecConflictChip compact conflicts={conflictsByTicker?.get(r.ticker.toUpperCase()) ?? []} />
                  </td>
                  <td className={cn(TD, "text-right text-white/90")}>{r.spot.toFixed(r.spot < 10 ? 2 : 1)}</td>
                  <td className={cn(TD, "text-right text-amber-400")}>{r.strike.toFixed(r.strike < 10 ? 2 : 1)}</td>
                  <td className={cn(TD, "text-right text-sky-300/80 whitespace-nowrap")}>
                    {r.expiry.slice(5)}<span className="text-zinc-600">/{Math.round(r.dte)}d</span>
                  </td>
                  <td className={cn(TD, "text-right text-sky-300/70")} title={r.bidIsLive ? "Live bid" : "No live bid"}>
                    {r.bidIsLive && r.bid > 0 ? r.bid.toFixed(2) : "—"}
                  </td>
                  <td className={cn(TD, "text-right text-green-400 font-semibold")}>{r.weeklyIncomePct.toFixed(2)}</td>
                  <td className={cn(TD, "text-right text-white/80")}>{r.otmPct.toFixed(1)}</td>
                  <td className={cn(TD, "text-right text-sky-300/70")}>{r.delta != null ? r.delta.toFixed(2) : "—"}</td>
                  <td className={cn(TD, "text-right text-sky-300/70")}>{r.bufferSigmas != null ? `${r.bufferSigmas.toFixed(1)}σ` : "—"}</td>
                  <td className={cn(TD, "text-right font-semibold", scoreColor(r.optionScore))}>
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
