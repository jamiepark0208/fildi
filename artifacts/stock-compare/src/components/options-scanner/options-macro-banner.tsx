import { cn } from "@/lib/utils";
import { REGIME_INCOME_TARGET, REGIME_INCOME_FLOOR } from "@/lib/option-scorer-constants";
import type { MacroRegimeResult } from "./options-scanner-types";

// ── MacroBanner ───────────────────────────────────────────────────────────────

export function MacroBanner({ data }: { data: MacroRegimeResult | undefined }) {
  if (!data || data.vix == null) return null;
  const regimeStyle =
    data.regime === "LOW_VOL"  ? "text-blue-400 border-blue-500/30 bg-blue-500/5" :
    data.regime === "ELEVATED" ? "text-orange-400 border-orange-500/30 bg-orange-500/5" :
    data.regime === "EXTREME"  ? "text-red-400 border-red-500/30 bg-red-500/5" :
                                  "text-white border-border bg-card/50";
  const dirIcon =
    data.indexDirection === "RALLY" ? "▲" :
    data.indexDirection === "CRASH" ? "▼" : "–";
  const target = REGIME_INCOME_TARGET[data.regime];
  const floor  = REGIME_INCOME_FLOOR[data.regime];
  return (
    <div className={cn("flex items-center gap-3 px-3 py-1.5 rounded-md border text-xs", regimeStyle)}>
      <span className="font-semibold tracking-wide">{data.regime.replace("_", " ")}</span>
      <span>VIX {data.vix.toFixed(1)}</span>
      <span>{dirIcon} {data.indexDirection}</span>
      <span className="text-white">income target {floor === target ? `${target}%` : `${floor}–${target}%`}/wk</span>
    </div>
  );
}
