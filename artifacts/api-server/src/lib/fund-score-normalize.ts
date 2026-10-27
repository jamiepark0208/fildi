/** A83 — cohort z/rank normalize (split from fund-score-engine). */
import { winsorizeValues } from "./fundamentals-scoring-math.js";

const MIN_Z_N = 8;


export function normalizeCohort(
  values: (number | null)[],
  higherIsBetter: boolean,
  /** 10-27: only these members set the norm (reviewed peer mapping + enough data); the rest are scored against them. */
  reference?: boolean[],
): (number | null)[] {
  if (reference) {
    const basis = values.map((v, i) => (reference[i] && v != null && Number.isFinite(v) ? v : null));
    const nb = basis.filter((v) => v != null).length;
    if (nb >= 3 && basis.some((v, i) => v == null && values[i] != null && Number.isFinite(values[i]!))) {
      return normalizeAgainst(values, basis as (number | null)[], nb, higherIsBetter);
    }
  }
  const idxs: number[] = [];
  values.forEach((v, i) => {
    if (v != null && Number.isFinite(v)) idxs.push(i);
  });
  const out: (number | null)[] = values.map(() => null);
  if (idxs.length === 0) return out;

  const winsorized = idxs.length >= 10 ? winsorizeValues(values, 0.02, 0.98, 5) : values;

  if (idxs.length >= MIN_Z_N) {
    const nums = idxs.map((i) => winsorized[i] as number);
    const mean = nums.reduce((s, v) => s + v, 0) / nums.length;
    const variance = nums.reduce((s, v) => s + (v - mean) ** 2, 0) / nums.length;
    const std = Math.sqrt(variance);
    for (const i of idxs) {
      const wv = winsorized[i] as number;
      let z = std === 0 ? 0 : (wv - mean) / std;
      z = Math.max(-3, Math.min(3, z));
      const score01 = (z + 3) / 6;
      out[i] = higherIsBetter ? score01 : 1 - score01;
    }
  } else {
    const sorted = [...idxs].sort((a, b) =>
      higherIsBetter
        ? (winsorized[b] as number) - (winsorized[a] as number)
        : (winsorized[a] as number) - (winsorized[b] as number),
    );
    sorted.forEach((i, rankIdx) => {
      out[i] = idxs.length > 1 ? (idxs.length - 1 - rankIdx) / (idxs.length - 1) : 1;
    });
  }
  return out;
}

/** Score every value against the reference values only (same z / rank rules as normalizeCohort). */
function normalizeAgainst(values: (number | null)[], basis: (number | null)[], nb: number, higherIsBetter: boolean): (number | null)[] {
  const ref = (nb >= 10 ? winsorizeValues(basis, 0.02, 0.98, 5) : basis).filter((v): v is number => v != null);
  const lo = Math.min(...ref), hi = Math.max(...ref);
  return values.map((v) => {
    if (v == null || !Number.isFinite(v)) return null;
    const w = nb >= 10 ? Math.min(hi, Math.max(lo, v)) : v;
    if (nb >= MIN_Z_N) {
      const mean = ref.reduce((s, x) => s + x, 0) / ref.length;
      const std = Math.sqrt(ref.reduce((s, x) => s + (x - mean) ** 2, 0) / ref.length);
      const z = Math.max(-3, Math.min(3, std === 0 ? 0 : (w - mean) / std));
      return higherIsBetter ? (z + 3) / 6 : 1 - (z + 3) / 6;
    }
    const worse = ref.filter((x) => (higherIsBetter ? x < w : x > w)).length;
    return Math.min(1, worse / (nb - 1));
  });
}
