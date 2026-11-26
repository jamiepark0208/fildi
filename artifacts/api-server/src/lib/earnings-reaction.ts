/** After-close assumed: the calendar has no before-open flag. */

export type Close = { date: string; c: number };

/** Pre is the last close on or before the report date. Day 1 is the first close after it. */
export function splitReportSessions(rd: string, closes: Close[]): { pre: Close | null; post: Close[] } {
  const ordered = [...closes].sort((a, b) => a.date.localeCompare(b.date));
  let pre: Close | null = null;
  for (const row of ordered) if (row.date <= rd) pre = row;
  return { pre, post: ordered.filter((row) => row.date > rd) };
}
