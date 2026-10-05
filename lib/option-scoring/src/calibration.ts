// Score calibration: map optionScore → historical expectancy (avg pnlPct) by side.
// Used to soft-haircut or hard-skip strikes in buckets with proven negative edge.
// Pure — shared by api-server (recompute + snapshot) and unit tests.

export type OptionSide = "put" | "call";

export interface GradedRecForCalibration {
  side: OptionSide;
  optionScore: number;
  pnlPct: number;
  /** ISO date — used for walk-forward splits */
  snapshotDate?: string;
}

export interface ScoreBucketExpectancy {
  /** Inclusive lower bound of optionScore for this bucket (0–100). */
  lo: number;
  /** Exclusive upper bound (100 for last bucket). */
  hi: number;
  n: number;
  avgPnlPct: number;
  winRate: number;
}

export interface SideCalibration {
  side: OptionSide;
  /** Quintile (or coarser) buckets sorted by lo ascending. */
  buckets: ScoreBucketExpectancy[];
  /** Trailing window / fold metadata for audit. */
  n: number;
  updatedAt: string;
  /** trainEnd exclusive for walk-forward; null = full sample */
  trainEndDate: string | null;
}

export interface CalibrationTable {
  put: SideCalibration;
  call: SideCalibration;
  version: number;
}

export const CALIBRATION_MIN_N_BUCKET = 25;
export const CALIBRATION_MIN_N_SIDE = 80;
export const CALIBRATION_NEGATIVE_HAIRCUT = 0.85; // multiply score when bucket expectancy < 0
export const CALIBRATION_HARD_SKIP_EXPECTANCY = -0.35; // skip strikes in buckets this bad (with n≥min)
export const CALIBRATION_VERSION = 1;

/** Map optionScore [0,100] → bucket index for 5 equal-width quintiles. */
export function scoreBucketIndex(optionScore: number, bucketCount = 5): number {
  const s = Math.max(0, Math.min(99.999, optionScore));
  return Math.min(bucketCount - 1, Math.floor((s / 100) * bucketCount));
}

export function bucketBounds(index: number, bucketCount = 5): { lo: number; hi: number } {
  const width = 100 / bucketCount;
  const lo = Math.round(index * width * 10) / 10;
  const hi = index === bucketCount - 1 ? 100 : Math.round((index + 1) * width * 10) / 10;
  return { lo, hi };
}

export function buildSideCalibration(
  side: OptionSide,
  recs: GradedRecForCalibration[],
  opts?: { trainEndDate?: string | null; bucketCount?: number },
): SideCalibration {
  const bucketCount = opts?.bucketCount ?? 5;
  const trainEnd = opts?.trainEndDate ?? null;
  const filtered = recs.filter((r) => {
    if (r.side !== side) return false;
    if (trainEnd && r.snapshotDate && r.snapshotDate >= trainEnd) return false;
    return Number.isFinite(r.optionScore) && Number.isFinite(r.pnlPct);
  });

  const buckets: ScoreBucketExpectancy[] = [];
  for (let i = 0; i < bucketCount; i++) {
    const { lo, hi } = bucketBounds(i, bucketCount);
    const inB = filtered.filter((r) => r.optionScore >= lo && r.optionScore < (i === bucketCount - 1 ? 101 : hi));
    const n = inB.length;
    const avgPnlPct = n > 0 ? inB.reduce((s, r) => s + r.pnlPct, 0) / n : 0;
    const wins = inB.filter((r) => r.pnlPct > 0).length;
    buckets.push({ lo, hi, n, avgPnlPct, winRate: n > 0 ? wins / n : 0 });
  }

  return {
    side,
    buckets,
    n: filtered.length,
    updatedAt: new Date().toISOString(),
    trainEndDate: trainEnd,
  };
}

export function buildCalibrationTable(
  recs: GradedRecForCalibration[],
  opts?: { trainEndDate?: string | null },
): CalibrationTable {
  return {
    put: buildSideCalibration("put", recs, opts),
    call: buildSideCalibration("call", recs, opts),
    version: CALIBRATION_VERSION,
  };
}

/** Walk-forward: train on snapshotDate < foldEnd, evaluate on [foldEnd, foldEnd+holdout). */
export function walkForwardCalibration(
  recs: GradedRecForCalibration[],
  foldEndDates: string[],
): Array<{ foldEnd: string; table: CalibrationTable; holdoutExpectancy: { put: number | null; call: number | null } }> {
  return foldEndDates.map((foldEnd) => {
    const table = buildCalibrationTable(recs, { trainEndDate: foldEnd });
    const holdout = recs.filter((r) => r.snapshotDate && r.snapshotDate >= foldEnd);
    const sideExp = (side: OptionSide): number | null => {
      const rows = holdout.filter((r) => r.side === side);
      if (rows.length === 0) return null;
      // Apply train calibration: only keep buckets with non-negative expectancy (or haircut)
      let sum = 0;
      let n = 0;
      for (const r of rows) {
        const adj = applyCalibrationToScore(r.optionScore, side, table);
        if (adj.skip) continue;
        sum += r.pnlPct;
        n++;
      }
      return n > 0 ? sum / n : null;
    };
    return {
      foldEnd,
      table,
      holdoutExpectancy: { put: sideExp("put"), call: sideExp("call") },
    };
  });
}

export interface CalibrationApplyResult {
  /** Multiplier in (0,1] applied to optionScore after scoring. */
  multiplier: number;
  /** Hard-skip this strike (bucket proven toxic). */
  skip: boolean;
  bucket: ScoreBucketExpectancy | null;
}

export function lookupBucket(
  optionScore: number,
  side: OptionSide,
  table: CalibrationTable | null | undefined,
): ScoreBucketExpectancy | null {
  if (!table) return null;
  const cal = side === "put" ? table.put : table.call;
  if (cal.n < CALIBRATION_MIN_N_SIDE) return null;
  const idx = scoreBucketIndex(optionScore);
  return cal.buckets[idx] ?? null;
}

export function applyCalibrationToScore(
  optionScore: number,
  side: OptionSide,
  table: CalibrationTable | null | undefined,
): CalibrationApplyResult {
  const bucket = lookupBucket(optionScore, side, table);
  if (!bucket || bucket.n < CALIBRATION_MIN_N_BUCKET) {
    return { multiplier: 1, skip: false, bucket };
  }
  if (bucket.avgPnlPct <= CALIBRATION_HARD_SKIP_EXPECTANCY) {
    return { multiplier: 0, skip: true, bucket };
  }
  if (bucket.avgPnlPct < 0) {
    return { multiplier: CALIBRATION_NEGATIVE_HAIRCUT, skip: false, bucket };
  }
  return { multiplier: 1, skip: false, bucket };
}
