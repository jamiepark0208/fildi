/**
 * A83 — pure grading helpers (split from model-track-record.ts).
 * No DB / vendor I/O.
 */

export function expectedDirectionFor(regime: string): "bullish" | "bearish" | "neutral" {
  switch (regime) {
    case "expansion":
    case "recovery":    return "bullish";
    case "contraction":
    case "recession":   return "bearish";
    default:            return "neutral"; // late_cycle, stagflation, insufficient_data
  }
}

/** Settle-at-expiry from stock closes (SELL put/call). */
export function settleRec(input: {
  side: string; strike: number; spot: number; premium: number; close: number;
}): {
  intrinsic: number; pnlPerShare: number; pnlPct: number; status: "WIN" | "LOSS";
  managedPnlPerShare: number; managedPnlPct: number; managedStatus: "WIN" | "LOSS";
} {
  const intrinsic = input.side === "put"
    ? Math.max(input.strike - input.close, 0)
    : Math.max(input.close - input.strike, 0);
  const pnlPerShare = input.premium - intrinsic;
  const basis = input.side === "put" ? input.strike : input.spot;
  const pnlPct = basis > 0 ? (pnlPerShare / basis) * 100 : 0;
  const status: "WIN" | "LOSS" = pnlPerShare > 0 ? "WIN" : "LOSS";
  const managedPnlPerShare = pnlPerShare > 0
    ? 0.5 * input.premium
    : Math.max(pnlPerShare, -2 * input.premium);
  const managedPnlPct = basis > 0 ? (managedPnlPerShare / basis) * 100 : 0;
  const managedStatus: "WIN" | "LOSS" = managedPnlPerShare > 0 ? "WIN" : "LOSS";
  return { intrinsic, pnlPerShare, pnlPct, status, managedPnlPerShare, managedPnlPct, managedStatus };
}

const REGIME_BAND: Record<string, number> = { "1w": 1, "4w": 2, "12w": 4 };
const NEUTRAL_DD_OK: Record<string, number> = { "1w": -3, "4w": -6, "12w": -10 };

export function gradeRegimeCall(input: {
  expectedDirection: string; horizon: string; fwdReturnPct: number; maxDrawdownPct: number;
}): "correct" | "partial" | "incorrect" {
  const band = REGIME_BAND[input.horizon] ?? 2;
  const fwd = input.fwdReturnPct;
  if (input.expectedDirection === "bullish") {
    if (fwd > band) return "correct";
    if (fwd < -band) return "incorrect";
    return "partial";
  }
  if (input.expectedDirection === "bearish") {
    if (fwd < -band) return "correct";
    if (fwd > band) return "incorrect";
    return "partial";
  }
  if (Math.abs(fwd) <= 1.5 * band || input.maxDrawdownPct >= (NEUTRAL_DD_OK[input.horizon] ?? -6)) {
    return Math.abs(fwd) > 3 * band ? "incorrect" : "correct";
  }
  return Math.abs(fwd) > 3 * band ? "incorrect" : "partial";
}

export function maxDrawdownPct(closes: number[]): number {
  let peak = -Infinity;
  let dd = 0;
  for (const c of closes) {
    if (c > peak) peak = c;
    else dd = Math.min(dd, (c / peak - 1) * 100);
  }
  return dd;
}
