import type { GuideStatusChips } from "@/hooks/use-guide-status";
import { StatusChipRow } from "@/components/scorecard-guide/tab-status-header";

type Props = {
  chips: GuideStatusChips;
};

/** Global connectivity strip below page title */
export function DataTransparencyBar({ chips }: Props) {
  return (
    <div className="mt-2">
      <StatusChipRow chips={chips} compact />
    </div>
  );
}
