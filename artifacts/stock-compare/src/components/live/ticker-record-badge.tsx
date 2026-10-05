// Compact accountability badge: W-L + optional Shrp + StkΔ vs open model rec.
import type { TickerRecord } from "@/hooks/use-ticker-track-record";
import { cn } from "@/lib/utils";

export function TickerRecordBadge({
  record,
  livePrice,
  side = "put",
  className = "ml-1.5",
}: {
  record: TickerRecord | undefined;
  /** Live underlying — enables StkΔ vs open model Spot@ */
  livePrice?: number | null;
  /** put: stock up = safer (green). call: stock up = stress (red). */
  side?: "put" | "call";
  className?: string;
}) {
  if (!record || record.wins + record.losses === 0) {
    // Still show open-rec stress if we have an open model pick with no grades yet
    if (!record?.openSpot || livePrice == null || !(record.openSpot > 0)) return null;
  }

  const wins = record?.wins ?? 0;
  const losses = record?.losses ?? 0;
  const graded = wins + losses > 0;
  const color = !graded ? "text-zinc-400" : wins === losses ? "text-amber-300" : wins > losses ? "text-emerald-400" : "text-rose-400";

  const sharpe = record?.sharpe ?? null;
  const openSpot = record?.openSpot ?? null;
  const stkDelta =
    livePrice != null && openSpot != null && openSpot > 0
      ? ((livePrice - openSpot) / openSpot) * 100
      : null;
  // Seller-favorable: puts like up-moves; calls like down-moves
  const stkFavorable = stkDelta == null ? null : side === "call" ? stkDelta < 0 : stkDelta > 0;

  const tip = [
    graded ? `${wins} win${wins === 1 ? "" : "s"} / ${losses} loss${losses === 1 ? "" : "es"} (graded)` : null,
    sharpe != null ? `Shrp ${sharpe.toFixed(2)} (mean÷stdev P&L)` : graded && wins + losses < 3 ? "Shrp needs ≥3 graded" : null,
    openSpot != null ? `Model open Spot@ ${openSpot.toFixed(2)}${record?.openSnapshotDate ? ` (${record.openSnapshotDate})` : ""}` : null,
    stkDelta != null
      ? `StkΔ since Init ${stkDelta >= 0 ? "+" : ""}${stkDelta.toFixed(1)}% (${side === "call" ? "↓ helps short call" : "↑ helps short put"})`
      : null,
    record?.entryDelta != null ? `entry δ ${record.entryDelta.toFixed(3)}` : null,
  ].filter(Boolean).join(" · ");

  return (
    <span className={cn(className, "inline-flex items-center gap-1 text-[9px] font-mono font-semibold leading-none")} title={tip}>
      {graded && <span className={color}>{wins}W-{losses}L</span>}
      {sharpe != null && (
        <span className={cn(sharpe >= 1 ? "text-emerald-300/90" : sharpe >= 0 ? "text-sky-300/70" : "text-rose-400/80")}>
          S{sharpe.toFixed(1)}
        </span>
      )}
      {stkDelta != null && (
        <span className={cn(
          stkFavorable == null ? "text-zinc-400" : stkFavorable ? "text-green-400/80" : "text-red-400/80",
        )}>
          {stkDelta >= 0 ? "+" : ""}{stkDelta.toFixed(1)}%
        </span>
      )}
    </span>
  );
}
