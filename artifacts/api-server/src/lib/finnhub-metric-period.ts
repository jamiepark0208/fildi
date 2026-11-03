/** Finnhub /stock/metric timeliness: quarterly values use pull time; annual fallbacks lag ~9mo. */

const ANNUAL_LAG_MS = 280 * 86_400_000;

const BALANCE_FIELDS: Record<string, [quarterly: string, annual: string]> = {
  currentRatio: ["currentRatioQuarterly", "currentRatioAnnual"],
  priceToBook: ["pbQuarterly", "pbAnnual"],
  quickRatio: ["quickRatioQuarterly", "quickRatioAnnual"],
};

function metricNum(m: Record<string, unknown>, key: string): boolean {
  const v = m[key];
  if (v == null) return false;
  const n = Number(v);
  return Number.isFinite(n);
}

/** Epoch ms for source_fundamentals.fetched_at (timeliness pick, not statement period). */
export function finnhubFieldTimelinessMs(
  metric: Record<string, unknown> | undefined,
  field: string,
  pulledAt: Date,
): number {
  const keys = BALANCE_FIELDS[field];
  if (!metric || !keys) return pulledAt.getTime();
  const [q, a] = keys;
  if (metricNum(metric, q)) return pulledAt.getTime();
  if (metricNum(metric, a)) return pulledAt.getTime() - ANNUAL_LAG_MS;
  return pulledAt.getTime();
}

export function finnhubQuarterlyOrAnnual(
  m: Record<string, unknown>,
  quarterlyKey: string,
  annualKey: string,
): number | undefined {
  const q = m[quarterlyKey];
  if (q != null) {
    const n = Number(q);
    if (Number.isFinite(n)) return n;
  }
  const a = m[annualKey];
  if (a != null) {
    const n = Number(a);
    if (Number.isFinite(n)) return n;
  }
  return undefined;
}
