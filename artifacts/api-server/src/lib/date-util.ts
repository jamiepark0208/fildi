/**
 * Shared calendar / DTE helpers (A83 Wave 1).
 * Keep semantics per caller — options ceil can go negative; Schwab clamps at 0.
 */

const DAY_MS = 86_400_000;

function toTime(d: Date | unknown): number | null {
  if (d instanceof Date) {
    const t = d.getTime();
    return Number.isFinite(t) ? t : null;
  }
  return null;
}

/** Fractional days until `d` (negative if past). Non-Date → 0 (options/Yahoo path). */
export function exactDaysUntil(d: Date | unknown): number {
  const t = toTime(d);
  if (t == null) return 0;
  return (t - Date.now()) / DAY_MS;
}

/** Calendar ceil of exactDaysUntil — can be negative (options chain path). */
export function daysUntilCeil(d: Date | unknown): number {
  return Math.ceil(exactDaysUntil(d));
}

/** Like daysUntilCeil but never below 0 (Schwab chain path). */
export function daysUntilCeilNonNeg(d: Date | unknown): number {
  return Math.max(0, daysUntilCeil(d));
}

/**
 * Whole calendar days until an ISO date string (catalysts: noon local if date-only).
 * Uses Math.round — not ceil.
 */
export function calendarDaysUntil(iso: string): number {
  const d = new Date(iso.includes("T") ? iso : `${iso}T12:00:00`).getTime();
  if (!Number.isFinite(d)) return 0;
  return Math.round((d - Date.now()) / DAY_MS);
}

/**
 * Whole calendar days until YYYY-MM-DD (midnight local vs today midnight) — LSEG radar path.
 */
export function calendarDaysUntilYmd(isoDate: string): number {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const t = new Date(`${isoDate.slice(0, 10)}T00:00:00`).getTime();
  if (!Number.isFinite(t)) return 0;
  return Math.round((t - today.getTime()) / DAY_MS);
}

/** Options settle offset after expiry weekday (Fri→Mon = 3, etc.). */
export function settlementOffsetDays(expiryDate: Date): number {
  const day = expiryDate.getDay();
  if (day === 5) return 3;
  if (day === 6) return 2;
  if (day === 0) return 1;
  return 1;
}
