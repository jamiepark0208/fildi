/**
 * Pure path-risk math for model recs (no DB). Used by grading + Track Record.
 */

export interface PathRisk {
  maxAdversePct: number;
  maxFavorablePct: number;
  /** % of OTM cushion consumed (null if no positive OTM buffer at entry). Can exceed 100 if strike breached. */
  cushionUsedPct: number | null;
  pathHigh: number;
  pathLow: number;
  bars: number;
}

/**
 * Seller-view max adverse / favorable excursion + OTM cushion used.
 * Put adverse = downside (spot → pathLow); call adverse = upside (spot → pathHigh).
 */
export function computePathRisk(input: {
  side: "put" | "call" | string;
  spot: number;
  strike: number;
  highs: number[];
  lows: number[];
}): PathRisk | null {
  const { side, spot, strike, highs, lows } = input;
  if (!(spot > 0) || highs.length === 0 || lows.length === 0) return null;
  const n = Math.min(highs.length, lows.length);
  let pathHigh = -Infinity;
  let pathLow = Infinity;
  for (let i = 0; i < n; i++) {
    const h = highs[i]!;
    const l = lows[i]!;
    if (Number.isFinite(h)) pathHigh = Math.max(pathHigh, h);
    if (Number.isFinite(l)) pathLow = Math.min(pathLow, l);
  }
  if (!Number.isFinite(pathHigh) || !Number.isFinite(pathLow)) return null;

  const maxAdversePct = side === "call"
    ? Math.max(0, (pathHigh - spot) / spot * 100)
    : Math.max(0, (spot - pathLow) / spot * 100);
  const maxFavorablePct = side === "call"
    ? Math.max(0, (spot - pathLow) / spot * 100)
    : Math.max(0, (pathHigh - spot) / spot * 100);

  let cushionUsedPct: number | null = null;
  if (side === "call") {
    const cushion = strike - spot;
    if (cushion > 0) cushionUsedPct = Math.max(0, (pathHigh - spot) / cushion * 100);
  } else {
    const cushion = spot - strike;
    if (cushion > 0) cushionUsedPct = Math.max(0, (spot - pathLow) / cushion * 100);
  }

  return {
    maxAdversePct: Math.round(maxAdversePct * 100) / 100,
    maxFavorablePct: Math.round(maxFavorablePct * 100) / 100,
    cushionUsedPct: cushionUsedPct != null ? Math.round(cushionUsedPct * 10) / 10 : null,
    pathHigh,
    pathLow,
    bars: n,
  };
}
