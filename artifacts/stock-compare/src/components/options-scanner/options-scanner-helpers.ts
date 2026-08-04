import type { MacroRegime } from "@/lib/option-scorer-constants";
import type { OptionRow, OptionsChainResult, ScorecardRow } from "./options-scanner-types";

// ── Helpers ───────────────────────────────────────────────────────────────────

export function formatExpiry(expiry: string, dte: number): string {
  const d     = new Date(expiry + "T12:00:00");
  const month = d.toLocaleString("en-US", { month: "short" });
  const weeks = Math.ceil(dte / 7);
  return `${month} ${d.getDate()} · ${weeks}wk`;
}

export function minutesAgo(d: Date): string {
  const mins = Math.floor((Date.now() - d.getTime()) / 60_000);
  if (mins < 1) return "just now";
  return `${mins} min ago`;
}

export function viableOptionStrikes(
  chains: OptionsChainResult[],
  minWeeklyIncome: number,
  isCall: boolean = false,
): Array<{ chain: OptionsChainResult; put: OptionRow; weeklyIncome: number }> {
  return chains
    .flatMap(c => {
      const settlementDte = c.settlementDte ?? c.exactDte ?? Math.max(1, c.daysToExpiry);
      return (isCall ? c.calls : c.puts)
        .map(p => ({ chain: c, put: p, weeklyIncome: p.incomePct / (settlementDte / 7) }))
        .filter(x => x.weeklyIncome >= minWeeklyIncome);
    });
}

export function optionStrikeSummary(
  chains: OptionsChainResult[] | null,
  minWeeklyIncome: number,
  isCall: boolean = false,
): string {
  if (!chains) return "—";
  const strikes = viableOptionStrikes(chains, minWeeklyIncome, isCall);
  if (strikes.length === 0) return "no viable strikes";
  const best = Math.max(...strikes.map(s => s.weeklyIncome));
  return `${strikes.length} strike${strikes.length !== 1 ? "s" : ""} · best ${best.toFixed(2)}%/wk`;
}

// RSI thresholds are per-ticker, calibrated from historical win rate by tier — not a
// universal constant. Shown alongside the threshold so "35" reads as a calibrated value,
// not an arbitrary hardcode. See RSI_THRESHOLDS / TIER_MAP in api-server/src/lib/constants.ts.
const TIER_WIN_RATE: Record<1 | 2 | 3, string> = {
  1: "≥92%",
  2: "≥94%",
  3: "≥97%",
};

export function buildReasoning(d: ScorecardRow, firstIV: number | null, macroRegime: MacroRegime = "BASELINE"): string {
  const tierPart = ` (Tier ${d.tier}, ${TIER_WIN_RATE[d.tier]} win rate)`;
  if (d.signal === "GO") {
    const ivPct = d.ivCurrent && d.ivCurrent > 0
      ? d.ivCurrent.toFixed(0)
      : firstIV != null ? (firstIV * 100).toFixed(0) : null;
    const ivPart     = ivPct != null ? ` — IV ${ivPct}%` : "";
    const spyPart    = d.vsSpy20d != null
      ? `, ${d.vsSpy20d > 0 ? "up" : "down"} ${Math.abs(d.vsSpy20d).toFixed(1)}% vs SPY`
      : "";
    const regimePart = macroRegime !== "BASELINE" ? ` · ${macroRegime.replace("_", " ").toLowerCase()} regime` : "";
    return `RSI ${d.rsi.toFixed(1)} / ${d.rsiThreshold}, MFI ${d.mfi.toFixed(1)} / 25${spyPart}${ivPart}${regimePart}`;
  }
  if (d.signal === "WATCH") {
    if (!d.mfiOk) return `MFI ${d.mfi.toFixed(1)} slightly above 25 — monitor for weakening`;
    return `RSI ${d.rsi.toFixed(1)} near threshold ${d.rsiThreshold}${tierPart} — monitor`;
  }
  if (!d.rsiOk) return `RSI ${d.rsi.toFixed(1)} above threshold ${d.rsiThreshold}${tierPart}`;
  if (!d.mfiOk) return `MFI ${d.mfi.toFixed(1)} above 25`;
  if (d.return5d != null && d.return5d > 5) return `Up +${d.return5d.toFixed(1)}% in 5d — entry score reduced`;
  return "conditions not met";
}
