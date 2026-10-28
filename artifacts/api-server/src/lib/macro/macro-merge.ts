/**
 * A failed refresh must never overwrite good saved macro data (A303, runtime audit 10-28). Before, only the yield
 * curve and a hand-picked list of chart series were protected; a FRED/CNN/Yahoo outage blanked everything else.
 *
 * mergeWithPrior walks fresh vs prior at any depth: where the fresh value carries no data and the prior one does,
 * the prior value is kept. "Data" = a finite number or non-empty text somewhere inside, except label fields
 * (LABEL_KEYS: tenor, unit, symbol, level…) and flags — so `{ tenor: "2Y", current: null }` or
 * `{ value: null, unit: "%" }` read as empty, while a text-only summary still counts as fresh data.
 * Arrays and series objects are taken whole (never mixed point by point).
 */

/** Fields that label a value rather than carry it — present even when the fetch failed (any type: `months: 1` on a
 *  yield-curve point, `date` on a chart point). Checked against the real macro-data / macro-charts files (A303). */
export const LABEL_KEYS = new Set(["tenor", "maturity", "months", "unit", "symbol", "ticker", "name", "label", "level",
  "displayName", "source", "dataset", "id", "frequency", "date", "meetingDate", "period"]);

export function hasData(v: unknown, key?: string): boolean {
  if (key && LABEL_KEYS.has(key)) return false;
  if (typeof v === "number") return Number.isFinite(v);
  if (typeof v === "string") return v.trim() !== "";
  if (Array.isArray(v)) return v.some((x) => hasData(x));
  if (v && typeof v === "object") return Object.entries(v as Record<string, unknown>).some(([k, x]) => hasData(x, k));
  return false;
}

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === "object" && !Array.isArray(v);

export function mergeWithPrior<T>(fresh: T, prior: unknown): T {
  if (prior == null) return fresh;
  if (!hasData(fresh)) return hasData(prior) ? (prior as T) : fresh;
  if (!isPlainObject(fresh) || !isPlainObject(prior)) return fresh;
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(fresh)) out[k] = mergeWithPrior(fresh[k], prior[k]); // keys only in prior = old schema → dropped
  return out as T;
}

/** Names of top-level keys where the prior value was kept (for one log line per refresh). */
export function keptFromPrior(fresh: unknown, merged: unknown): string[] {
  if (!isPlainObject(fresh) || !isPlainObject(merged)) return [];
  return Object.keys(merged).filter((k) => merged[k] !== fresh[k]);
}
