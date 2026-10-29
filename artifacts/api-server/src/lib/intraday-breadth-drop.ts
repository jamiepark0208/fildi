/** Pure breadth-drop rule (A314 / S143) — no DB imports (testable without DATABASE_URL). */
export const BREADTH_DROP_PP = 0.08;
export const BREADTH_LOOKBACK_BARS = 6;

export function breadthChg30(history: number[]): number | null {
  if (history.length < BREADTH_LOOKBACK_BARS + 1) return null;
  const cur = history[history.length - 1];
  const prev = history[history.length - 1 - BREADTH_LOOKBACK_BARS];
  return cur - prev;
}

export function isBreadthDrop(chg30: number | null): boolean {
  return chg30 != null && chg30 <= -BREADTH_DROP_PP;
}
