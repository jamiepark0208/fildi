/**
 * A83 — OHLCV staleness helpers (split from indicators.ts).
 */
import { lastCompletedSessionYmd, etDateKey } from "./market-hours.js";

const STALE_OHLCV_DAYS = 4;

export { etDateKey };

/** Count Mon–Fri dates strictly after `fromYmd` through `toYmd` (inclusive of to if weekday). */
export function etTradingDaysBehind(fromYmd: string | null, toYmd?: string): number {
  if (!fromYmd) return 999;
  const to = toYmd ?? etDateKey();
  const [fy, fm, fd] = fromYmd.slice(0, 10).split("-").map(Number);
  const [ty, tm, td] = to.slice(0, 10).split("-").map(Number);
  const cur = new Date(Date.UTC(fy!, fm! - 1, fd!));
  const end = new Date(Date.UTC(ty!, tm! - 1, td!));
  if (cur >= end) return 0;
  let n = 0;
  cur.setUTCDate(cur.getUTCDate() + 1);
  while (cur <= end) {
    const dow = cur.getUTCDay();
    if (dow !== 0 && dow !== 6) n++;
    cur.setUTCDate(cur.getUTCDate() + 1);
  }
  return n;
}

/**
 * Stale if missing the last completed ET session bar, or > STALE_OHLCV_DAYS calendar days.
 */
export function isOHLCVStale(latestDate: string | null): boolean {
  if (!latestDate) return true;
  const ymd = String(latestDate).slice(0, 10);
  if (ymd < lastCompletedSessionYmd()) return true;
  const calDays = (Date.now() - new Date(`${ymd}T16:00:00-04:00`).getTime()) / 86_400_000;
  return calDays > STALE_OHLCV_DAYS;
}
