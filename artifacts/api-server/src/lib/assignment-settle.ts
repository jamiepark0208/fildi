/**
 * A92 — assignment-aware settlement for synthetic short option recs.
 * Headline exit = close of trading day 10 after expiry (Jamie 10-14).
 * Best/worst band over the same window is secondary (hindsight), never the grade.
 */

export type AssignmentSide = "put" | "call";

export interface AssignmentWindow {
  /** Trading-day closes after expiry, oldest first (index 0 = first session after expiry). */
  closes: number[];
  /** Close on/just before expiry — used for premium intrinsic only. */
  expiryClose: number;
}

export interface AssignmentSettle {
  assigned: boolean;
  intrinsic: number;
  /** Premium-only (same as settleRec). */
  premiumPnlPerShare: number;
  /** Day-10 stock-leg P&L; 0 if OTM or window incomplete. */
  stockPnlPerShare: number | null;
  /** premium + stock (day-10). null while ASSIGNED / incomplete window. */
  allInPnlPerShare: number | null;
  /** Hindsight band over available closes in the window. */
  bestPnlPerShare: number | null;
  worstPnlPerShare: number | null;
  /** Trading days after expiry available. */
  windowDays: number;
  windowComplete: boolean;
  day10Close: number | null;
}

const WINDOW = 10;

export function premiumIntrinsic(side: AssignmentSide, strike: number, expiryClose: number): number {
  return side === "put"
    ? Math.max(strike - expiryClose, 0)
    : Math.max(expiryClose - strike, 0);
}

/** Stock-leg P&L if assigned at strike and flat at `exitClose`. */
export function stockLegPnl(side: AssignmentSide, strike: number, exitClose: number): number {
  return side === "put" ? exitClose - strike : strike - exitClose;
}

/**
 * Settle short option + optional assignment stock leg.
 * OTM → premium only, all-in = premium. ITM → need 10 trading closes after expiry.
 */
export function settleWithAssignment(input: {
  side: AssignmentSide;
  strike: number;
  premium: number;
  window: AssignmentWindow;
}): AssignmentSettle {
  const { side, strike, premium, window } = input;
  const intrinsic = premiumIntrinsic(side, strike, window.expiryClose);
  const premiumPnlPerShare = premium - intrinsic;
  const assigned = intrinsic > 0;

  if (!assigned) {
    return {
      assigned: false,
      intrinsic,
      premiumPnlPerShare,
      stockPnlPerShare: 0,
      allInPnlPerShare: premiumPnlPerShare,
      bestPnlPerShare: premiumPnlPerShare,
      worstPnlPerShare: premiumPnlPerShare,
      windowDays: window.closes.length,
      windowComplete: true,
      day10Close: null,
    };
  }

  const closes = window.closes.filter((c) => Number.isFinite(c) && c > 0);
  const windowDays = closes.length;
  const windowComplete = windowDays >= WINDOW;
  const day10Close = windowComplete ? closes[WINDOW - 1]! : null;

  let stockPnlPerShare: number | null = null;
  let allInPnlPerShare: number | null = null;
  if (day10Close != null) {
    stockPnlPerShare = stockLegPnl(side, strike, day10Close);
    allInPnlPerShare = premium + stockPnlPerShare;
  }

  let bestPnlPerShare: number | null = null;
  let worstPnlPerShare: number | null = null;
  if (closes.length > 0) {
    const legs = closes.map((c) => premium + stockLegPnl(side, strike, c));
    bestPnlPerShare = Math.max(...legs);
    worstPnlPerShare = Math.min(...legs);
  }

  return {
    assigned: true,
    intrinsic,
    premiumPnlPerShare,
    stockPnlPerShare,
    allInPnlPerShare,
    bestPnlPerShare,
    worstPnlPerShare,
    windowDays,
    windowComplete,
    day10Close,
  };
}

/** Grade status from all-in (or premium if OTM). ASSIGNED while ITM window open. */
export function assignmentStatus(s: AssignmentSettle): "WIN" | "LOSS" | "ASSIGNED" {
  if (s.assigned && !s.windowComplete) return "ASSIGNED";
  const pnl = s.allInPnlPerShare ?? s.premiumPnlPerShare;
  return pnl > 0 ? "WIN" : "LOSS";
}
