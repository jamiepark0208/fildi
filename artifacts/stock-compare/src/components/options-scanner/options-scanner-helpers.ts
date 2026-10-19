import { assessOptionChainQuoteDq } from "@/lib/option-scorer";
import type { MacroRegime } from "@/lib/option-scorer-constants";
import type { OptionRow, OptionsChainResult, ScorecardRow } from "./options-scanner-types";

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Standard equity monthly = 3rd Friday (day-of-month 15–21). */
export function isStandardMonthlyExpiry(expiry: string): boolean {
  const d = new Date(expiry + "T12:00:00");
  return d.getDay() === 5 && d.getDate() >= 15 && d.getDate() <= 21;
}

export function formatExpiry(expiry: string, dte: number, isWeekly?: boolean): string {
  const d     = new Date(expiry + "T12:00:00");
  const month = d.toLocaleString("en-US", { month: "short" });
  const monthly = isWeekly === false || (isWeekly == null && isStandardMonthlyExpiry(expiry));
  if (monthly) return `${month} ${d.getDate()} · monthly`;
  const weeks = Math.ceil(dte / 7);
  return `${month} ${d.getDate()} · ${weeks}wk`;
}

/** True when every loaded chain is a standard monthly (no weeklies in the response). */
export function isMonthlyOnlyCalendar(chains: OptionsChainResult[] | null | undefined): boolean {
  if (!chains?.length) return false;
  return chains.every((c) => c.isWeekly === false || isStandardMonthlyExpiry(c.expiry));
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
        .filter(p => p.meetsGate) // no live bid = not sellable, exclude from rankings entirely
        .map(p => ({ chain: c, put: p, weeklyIncome: p.incomePct / (settlementDte / 7) }))
        .filter(x => x.weeklyIncome >= minWeeklyIncome);
    });
}

/** Diagnose why the expanded panel says "no viable strikes" — lead with quote DQ when bids are missing. */
export function optionStrikeSummary(
  chains: OptionsChainResult[] | null,
  minWeeklyIncome: number,
  isCall: boolean = false,
): string {
  if (!chains) return "—";
  if (chains.length === 0) return "empty chain (no 1–28 DTE expiries)";

  const dq = assessOptionChainQuoteDq(chains, isCall);
  const side = isCall ? "calls" : "puts";

  const strikes = viableOptionStrikes(chains, minWeeklyIncome, isCall);
  if (strikes.length > 0) {
    const best = Math.max(...strikes.map(s => s.weeklyIncome));
    const src = dq.source !== "unknown" ? ` · ${dq.source}` : "";
    return `${strikes.length} strike${strikes.length !== 1 ? "s" : ""} · best ${best.toFixed(2)}%/wk${src}`;
  }

  // Zero live bids = data quality failure (we expect Schwab bids in RTH)
  if (dq.inBand > 0 && dq.withLiveBid === 0) {
    return dq.message;
  }
  if (dq.inBand === 0) {
    return `no ${side} in 3–25% OTM band (chain may be thin or all ATM/deep)`;
  }
  if (dq.meetsGate === 0 && dq.withLiveBid > 0) {
    return `${dq.withLiveBid} live bid${dq.withLiveBid !== 1 ? "s" : ""} rejected as implausible quotes (garbage filter)`;
  }

  let bestLive = 0;
  for (const c of chains) {
    const settlementDte = c.settlementDte ?? c.exactDte ?? Math.max(1, c.daysToExpiry);
    for (const p of (isCall ? c.calls : c.puts)) {
      if (!p.meetsGate) continue;
      const wk = p.incomePct / (settlementDte / 7);
      if (wk > bestLive) bestLive = wk;
    }
  }
  return (
    `${dq.meetsGate} live · all < ${minWeeklyIncome.toFixed(1)}%/wk min` +
    (bestLive > 0 ? ` (best ${bestLive.toFixed(2)}%/wk — lower Min %/wk or Override)` : "")
  );
}

export { assessOptionChainQuoteDq };

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
