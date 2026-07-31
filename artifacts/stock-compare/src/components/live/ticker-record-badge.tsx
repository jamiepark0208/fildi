// Compact "3W-1L" cumulative win/loss badge for a ticker's graded sell-put/sell-call
// history — shown inline next to the ticker in scanner/live tables.
import type { TickerRecord } from "@/hooks/use-ticker-track-record";

export function TickerRecordBadge({ record }: { record: TickerRecord | undefined }) {
  if (!record || record.wins + record.losses === 0) return null;
  const { wins, losses } = record;
  const color = wins === losses ? "text-amber-300" : wins > losses ? "text-emerald-400" : "text-rose-400";
  return (
    <span className={`ml-1.5 text-[10px] font-mono font-semibold ${color}`} title={`${wins} win${wins === 1 ? "" : "s"} / ${losses} loss${losses === 1 ? "" : "es"} (graded)`}>
      {wins}W-{losses}L
    </span>
  );
}
