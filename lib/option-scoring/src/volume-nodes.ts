/**
 * Daily volume-profile nodes (S045). A node between a put's strike and spot is a worse put,
 * not a safer one (79k weekly puts 2020→2026, IV-controlled: IC −0.015, t −3.9 on top of the
 * put-tuned tech score). Port of analysis/s045_put_retest.py volume_nodes.
 */
export interface DailyBar { high: number; low: number; volume: number }

const BINS = 24;

/** Top-4 volume-at-price node prices from the given bars (oldest → newest, ~60 sessions). */
export function computeVolumeNodes(bars: DailyBar[], bins = BINS): number[] {
  const ok = bars.filter((b) => b.high > 0 && b.low > 0 && b.high >= b.low);
  if (ok.length < 30) return [];
  const lo = Math.min(...ok.map((b) => b.low));
  const hi = Math.max(...ok.map((b) => b.high));
  if (!(hi > lo)) return [];
  const step = (hi - lo) / bins;
  const binOf = (p: number) => Math.min(bins - 1, Math.max(0, Math.floor((p - lo) / step)));
  const vac = new Array<number>(bins).fill(0);
  for (const b of ok) {
    const i0 = binOf(b.low);
    const i1 = Math.max(i0, binOf(b.high));
    const share = (b.volume || 0) / (i1 - i0 + 1);
    for (let i = i0; i <= i1; i++) vac[i]! += share;
  }
  const pos = vac.filter((v) => v > 0).sort((a, b) => a - b);
  if (pos.length === 0) return [];
  const mid = pos.length >> 1;
  const med = pos.length % 2 ? pos[mid]! : (pos[mid - 1]! + pos[mid]!) / 2;
  const peaks: { price: number; vol: number }[] = [];
  for (let i = 1; i < bins - 1; i++) {
    if (vac[i]! >= vac[i - 1]! && vac[i]! >= vac[i + 1]! && vac[i]! >= med) {
      peaks.push({ price: lo + (i + 0.5) * step, vol: vac[i]! });
    }
  }
  return peaks.sort((a, b) => b.vol - a.vol).slice(0, 4).map((p) => p.price);
}

/**
 * Quantile-match `scores` onto `reference`'s distribution (A167): keeps the new ordering but the
 * old levels, so level-calibrated gates (SQ_FLOOR_BASE 0.45 on stockQuality) don't shift when a
 * lane switches tech weights. Tickers missing from either map pass through unchanged.
 */
export function matchDistribution(scores: Map<string, number>, reference: Map<string, number>): Map<string, number> {
  const ref = [...reference.values()].filter(Number.isFinite).sort((a, b) => a - b);
  const order = [...scores.entries()].filter(([, v]) => Number.isFinite(v)).sort((a, b) => a[1] - b[1]);
  if (ref.length < 2 || order.length < 2) return new Map(scores);
  const out = new Map(scores);
  order.forEach(([t], i) => {
    const q = i / (order.length - 1);
    const pos = q * (ref.length - 1);
    const lo = Math.floor(pos);
    const hi = Math.min(ref.length - 1, lo + 1);
    out.set(t, ref[lo]! + (ref[hi]! - ref[lo]!) * (pos - lo));
  });
  return out;
}

/** Put strike component: 1 = no node between strike and spot, 0 = a node sits in that gap. Null when unknown. */
export function scoreNodeGap(strike: number, spot: number, nodes: number[] | null | undefined): number | null {
  if (!nodes || nodes.length === 0 || !(spot > 0) || !(strike > 0)) return null;
  return nodes.some((z) => z > strike && z < spot) ? 0 : 1;
}
