import type { GuideStatusChips } from "@/hooks/use-guide-status";
import { StatusChipRow } from "@/components/scorecard-guide/tab-status-header";

type Props = {
  /** Preferred — structured status badges */
  chips?: GuideStatusChips;
  /** @deprecated use chips — kept for partial deploy / HMR safety */
  factset?: boolean;
  fmp?: boolean;
  fmpRemaining?: number;
};

/** Global connectivity strip below page title */
export function DataTransparencyBar({ chips, factset, fmp, fmpRemaining }: Props) {
  if (chips) {
    return (
      <div className="mt-2">
        <StatusChipRow chips={chips} compact />
      </div>
    );
  }

  return (
    <p className="text-sm text-foreground mt-2 truncate">
      Peer-ranked · FactSet {factset ? "Active" : "Inactive"} · FMP {fmp ? "Active" : "Inactive"}
      {fmpRemaining != null ? ` (${fmpRemaining} calls left)` : ""}
    </p>
  );
}
