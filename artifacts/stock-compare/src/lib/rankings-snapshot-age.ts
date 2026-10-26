/**
 * A275 — Live table stale badge for option_score_snapshots asOf (ET trading days).
 * Nightly job writes asOf = session date. Friday snap on Monday = 1 trading day behind → OK.
 * Stale when > 1 weekday behind today ET.
 */

export function etYmd(d = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(d);
}

function parseYmdUtc(ymd: string): Date {
  const [y, m, d] = ymd.slice(0, 10).split("-").map(Number);
  return new Date(Date.UTC(y!, m! - 1, d!));
}

/** Weekdays from day after asOf through todayEt inclusive. Fri→Mon = 1. */
export function tradingDaysBehind(asOfYmd: string, todayYmd: string): number {
  const a = parseYmdUtc(asOfYmd);
  const t = parseYmdUtc(todayYmd);
  if (t.getTime() <= a.getTime()) return 0;
  let n = 0;
  const cur = new Date(a);
  cur.setUTCDate(cur.getUTCDate() + 1);
  while (cur.getTime() <= t.getTime()) {
    const wd = cur.getUTCDay();
    if (wd !== 0 && wd !== 6) n += 1;
    cur.setUTCDate(cur.getUTCDate() + 1);
  }
  return n;
}

export function rankingsSnapshotStale(
  asOf: string | null | undefined,
  now = new Date(),
): boolean {
  if (!asOf) return true;
  return tradingDaysBehind(asOf.slice(0, 10), etYmd(now)) > 1;
}
