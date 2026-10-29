/** Pure breadth-drop rule (A314 / S143) — no DB imports (testable without DATABASE_URL). */
export const BREADTH_DROP_PP = 0.08;
export const BREADTH_CHG30_MS = 30 * 60 * 1000;
export const BREADTH_TS_TOLERANCE_MS = 2 * 60 * 1000;

export type BreadthVwapPoint = { tsMs: number; aboveVwap: number };

/** Change in % above VWAP vs the row whose ts is ~30 min before the latest (±2 min). */
export function breadthChg30(series: BreadthVwapPoint[]): number | null {
  if (series.length < 2) return null;
  const latest = series[series.length - 1];
  const targetMs = latest.tsMs - BREADTH_CHG30_MS;
  let prev: BreadthVwapPoint | null = null;
  let bestDist = BREADTH_TS_TOLERANCE_MS + 1;
  for (let i = 0; i < series.length - 1; i++) {
    const row = series[i];
    const dist = Math.abs(row.tsMs - targetMs);
    if (dist <= BREADTH_TS_TOLERANCE_MS && dist < bestDist) {
      prev = row;
      bestDist = dist;
    }
  }
  if (!prev) return null;
  return latest.aboveVwap - prev.aboveVwap;
}

export function isBreadthDrop(chg30: number | null): boolean {
  return chg30 != null && chg30 <= -BREADTH_DROP_PP;
}
