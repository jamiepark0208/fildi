/**
 * A147: Yahoo `dividendYield = 0` is missing when another free source reports > 0.5%.
 */

export type SfPair = [source: string, sfField: string];

export function skipYahooZeroDividend(
  tf: string,
  src: string,
  val: number,
  byField: Map<string, Map<string, number>>,
  priority: SfPair[],
): boolean {
  if (tf !== "dividendYield" || src !== "yahoo" || val !== 0) return false;
  for (const [otherSrc, sfField] of priority) {
    if (otherSrc === "yahoo") continue;
    const other = byField.get(sfField)?.get(otherSrc);
    if (other != null && Number.isFinite(other) && other > 0.005) return true;
  }
  return false;
}
