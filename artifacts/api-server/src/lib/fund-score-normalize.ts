/** A83 — cohort z/rank normalize (split from fund-score-engine). */
import { winsorizeValues } from "./fundamentals-scoring-math.js";

const MIN_Z_N = 8;


export function normalizeCohort(values: (number | null)[], higherIsBetter: boolean): (number | null)[] {
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
