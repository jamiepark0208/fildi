/**
 * Calendar date for API usage / daily budgets.
 * Must match the operator's market day (US), not UTC — otherwise API Monitor
 * shows today's FactSet calls under "Yesterday" after 5pm PT / 00:00 UTC.
 */
export const USAGE_TIMEZONE = "America/Los_Angeles";

/** YYYY-MM-DD in USAGE_TIMEZONE. */
export function usageCalendarDate(now = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: USAGE_TIMEZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}
