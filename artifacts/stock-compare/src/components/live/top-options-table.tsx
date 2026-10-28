// Compact "best strikes right now" table for the Live tab — top-N unique tickers
// from the options scanner's own scoring (see useTopOptions), following the page's
// dip/rally side: dip → sell puts, rally → sell calls.
import { cn } from "@/lib/utils";
import { useTopOptions } from "@/hooks/use-top-options";
import { useTickerTrackRecord } from "@/hooks/use-ticker-track-record";
import { TickerRecordBadge } from "./ticker-record-badge";
import { scoreColor } from "./live-format";
import { RecConflictChip } from "./rec-conflict-chip";
import type { RecConflict } from "@/lib/rec-conflicts";
import { GRID_WRAP, GRID_HEADER, GRID_TH } from "@/lib/score-explain-format";
import { formatMdYy } from "@/lib/format";
import { rankingsSnapshotStale } from "@/lib/rankings-snapshot-age";

/** Match Track Record compact density */
const TH = cn(GRID_TH, "px-1.5 py-0.5");
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
  const { rows, isFetching, asOf, computedAt } = useTopOptions(side, n);
  const { data: tickerRecords } = useTickerTrackRecord();
  const stale = rankingsSnapshotStale(asOf);
  const asOfLabel = asOf ? formatMdYy(asOf) : null;
  const computedLabel = computedAt
    ? new Intl.DateTimeFormat("en-US", {
        timeZone: "America/New_York",
        month: "numeric",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
      }).format(new Date(computedAt))
    : null;

  const softCaution =
    regimeConfidence != null &&
    regimeConfidence >= 60 &&
    ((side === "put" && regimeDirection === "bearish") ||
      (side === "call" && regimeDirection === "bullish"));

  return (
    <div className="space-y-1.5">
      {softCaution && (
        <p className="text-[10px] text-amber-300/80 border border-amber-500/25 rounded px-1.5 py-0.5 bg-amber-500/5">
          Regime {regimeDirection} ({regimeConfidence}%) — soft caution on sell-{side}s.
        </p>
      )}
      {rows.length === 0 ? (
        <p className="text-[11px] text-amber-100/70">
          {isFetching ? "Loading nightly rankings…" : "No scored candidates yet — run Overall refresh."}
        </p>
      ) : (
        <div className={GRID_WRAP}>
          <div className={cn(GRID_HEADER, "px-2 py-1 flex flex-wrap items-center justify-between gap-x-2 gap-y-0.5")}>
            <h3 className="text-[10px] font-semibold text-[#d4af37] uppercase tracking-widest">
              Best strikes · {side === "put" ? "Puts" : "Calls"}
            </h3>
            <span
              className={cn(
                "text-[9px] font-mono",
                stale ? "text-orange-300 font-semibold" : "text-amber-100/80",
              )}
              title="option_score_snapshots from nightly Overall job (DB-only; no live quotes)"
            >
              {stale ? "STALE snapshot · " : "snapshot "}
              {asOfLabel ? `as of ${asOfLabel}` : "as of —"}
              {computedLabel ? ` · ran ${computedLabel} ET` : ""}
            </span>
          </div>
          <table className="w-full">
            <thead className="bg-black/60 text-[#d4af37]">
              <tr className="border-b border-[#d4af37]/15">
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
                    {r.relaxed && (
                      <span
                        className="ml-0.5 px-0.5 py-px rounded border border-violet-500/40 bg-violet-500/15 text-violet-200 text-[8px] font-bold leading-none"
                        title="Watchlist relaxed pick — not a strict Overall hit"
                      >
                        REL
                      </span>
                    )}
                    <TickerRecordBadge record={tickerRecords?.[r.ticker]?.[side]} livePrice={r.spot} side={side} />
                    <RecConflictChip compact conflicts={conflictsByTicker?.get(r.ticker.toUpperCase()) ?? []} />
                  </td>
                  <td className={cn(TD, "text-right text-green-500 font-semibold")}>
                    {r.spot.toLocaleString("en-US", {
                      minimumFractionDigits: r.spot < 10 ? 2 : 1,
                      maximumFractionDigits: r.spot < 10 ? 2 : 1,
                    })}
                  </td>
                  <td className={cn(TD, "text-right text-amber-400")}>
                    {r.strike.toLocaleString("en-US", {
                      minimumFractionDigits: r.strike < 10 ? 2 : 1,
                      maximumFractionDigits: r.strike < 10 ? 2 : 1,
                    })}
                  </td>
                  <td className={cn(TD, "text-right text-sky-300/80 whitespace-nowrap")}>
                    {r.expiry.slice(5)}<span className="text-zinc-600">/{Math.round(r.dte)}d</span>
                  </td>
                  <td className={cn(TD, "text-right text-sky-300/70")} title={r.bidIsLive ? "Live bid" : "No live bid"}>
                    {r.bidIsLive && r.bid > 0 ? r.bid.toFixed(2) : "—"}
                  </td>
                  <td className={cn(TD, "text-right text-green-500 font-semibold")}>{r.weeklyIncomePct.toFixed(2)}</td>
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
