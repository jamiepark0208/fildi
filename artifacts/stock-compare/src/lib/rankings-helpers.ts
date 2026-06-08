export const MIN_Z_N = 8;
export const MIN_SECTOR_N = 6;

export function safeDiv(
  num: number | null | undefined,
  den: number | null | undefined,
): number | null {
  if (num == null || den == null || den === 0 || !isFinite(den) || !isFinite(num)) return null;
  const r = num / den;
  return isFinite(r) ? r : null;
}

export function winsorize(
  values: (number | null)[],
  pLow = 0.05,
  pHigh = 0.95,
): (number | null)[] {
  const finite = values
    .filter((v): v is number => v != null && isFinite(v))
    .sort((a, b) => a - b);
  if (finite.length < 3) return values;
  const lo = finite[Math.floor((finite.length - 1) * pLow)];
  const hi = finite[Math.ceil((finite.length - 1) * pHigh)];
  return values.map(v => (v == null || !isFinite(v) ? null : Math.max(lo, Math.min(hi, v))));
}

export interface NormalizeOptions {
  higherIsBetter: boolean;
}

/**
 * Auto-selects z-score (winsorized) when >= MIN_Z_N non-null values exist in the group,
 * otherwise ordinal rank. Both return [0,1] scores; nulls remain null.
 * Safe for the 5-ticker compare view (n<8 → ordinal rank, no z-score instability).
 */
export function normalize(
  values: (number | null)[],
  opts: NormalizeOptions,
): (number | null)[] {
  const nonNull: { v: number; i: number }[] = [];
  values.forEach((v, i) => {
    if (v != null && isFinite(v)) nonNull.push({ v, i });
  });

  const out: (number | null)[] = values.map(() => null);
  if (nonNull.length === 0) return out;

  if (nonNull.length >= MIN_Z_N) {
    // Winsorized z-score path
    const winsorized = winsorize(values);
    const wNonNull = nonNull.map(({ i }) => winsorized[i] as number);
    const mean = wNonNull.reduce((s, v) => s + v, 0) / wNonNull.length;
    const variance = wNonNull.reduce((s, v) => s + (v - mean) ** 2, 0) / wNonNull.length;
    const std = Math.sqrt(variance);

    nonNull.forEach(({ i }) => {
      const wv = winsorized[i] as number;
      // std === 0 means all values are equal → neutral 0.5
      let z = std === 0 ? 0 : (wv - mean) / std;
      z = Math.max(-3, Math.min(3, z));
      const score01 = (z + 3) / 6;
      out[i] = opts.higherIsBetter ? score01 : 1 - score01;
    });
  } else {
    // Ordinal rank path — best gets 1.0, worst gets 0.0, single value gets 1.0
    const sorted = [...nonNull].sort((a, b) =>
      opts.higherIsBetter ? b.v - a.v : a.v - b.v,
    );
    sorted.forEach(({ i }, rankIdx) => {
      out[i] =
        nonNull.length > 1 ? (nonNull.length - 1 - rankIdx) / (nonNull.length - 1) : 1;
    });
  }

  return out;
}
