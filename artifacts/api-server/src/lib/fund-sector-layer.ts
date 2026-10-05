/**
 * Peer-group sector opportunity layer.
 * final = (1 − λ) × company + λ × sectorOpportunity
 *
 * Sector opportunity (peer-group level):
 *   50% size (log10 Σ USD mcap; speculative groups ×0.5)
 *   30% prospects (median rev growth + median ROE)
 *   20% cheapness (median 1/PE)
 * Then z-calibrated onto the company-score distribution so λ is a true blend weight.
 */
export const SECTOR_LAYER_WEIGHT = 0.10;

export const SECTOR_OPP_COMPONENT_WEIGHTS = {
  size: 0.5,
  prospects: 0.3,
  cheap: 0.2,
} as const;

export type SectorLayerRow = {
  peerGroupId: string | null;
  marketCap: number | null;
  revenueGrowthYoY: number | null;
  returnOnEquity: number | null;
  peRatio: number | null;
};

function median(nums: number[]): number | null {
  if (!nums.length) return null;
  const s = [...nums].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

/** Rank values → [0,1]; nulls stay null. HigherIsBetter controls sort direction. */
export function rank01(values: (number | null)[], higherIsBetter: boolean): (number | null)[] {
  const idxs = values
    .map((v, i) => (v != null && Number.isFinite(v) ? i : -1))
    .filter((i) => i >= 0);
  const out: (number | null)[] = values.map(() => null);
  if (idxs.length === 0) return out;
  const sorted = [...idxs].sort((a, b) =>
    higherIsBetter
      ? (values[b] as number) - (values[a] as number)
      : (values[a] as number) - (values[b] as number),
  );
  sorted.forEach((i, rankIdx) => {
    out[i] = idxs.length > 1 ? (idxs.length - 1 - rankIdx) / (idxs.length - 1) : 1;
  });
  return out;
}

/**
 * Raw peer-group opportunity in ~0–100 (centered ~50) before company-scale calibration.
 * Keyed by peerGroupId (orphans without a group are omitted).
 */
export function computeRawPeerGroupOpportunity(rows: SectorLayerRow[]): Map<string, number> {
  const byGroup = new Map<string, SectorLayerRow[]>();
  for (const r of rows) {
    if (!r.peerGroupId) continue;
    if (!byGroup.has(r.peerGroupId)) byGroup.set(r.peerGroupId, []);
    byGroup.get(r.peerGroupId)!.push(r);
  }

  type Feat = {
    id: string;
    sizeLog: number;
    medRevG: number | null;
    medRoe: number | null;
    medEy: number | null;
    speculative: boolean;
  };

  const groups: Feat[] = [];
  for (const [id, members] of byGroup) {
    const speculative = /speculative/i.test(id);
    const mcaps = members.map((m) => m.marketCap).filter((v): v is number => v != null && v > 0);
    const sizeSum = mcaps.reduce((s, v) => s + v, 0);
    const revGs = members
      .map((m) => m.revenueGrowthYoY)
      .filter((v): v is number => v != null && Number.isFinite(v))
      .map((v) => Math.max(-0.5, Math.min(1.0, v)));
    const roes = members
      .map((m) => m.returnOnEquity)
      .filter((v): v is number => v != null && Number.isFinite(v) && Math.abs(v) < 2);
    const eys = members
      .map((m) => (m.peRatio != null && m.peRatio >= 3 && m.peRatio <= 100 ? 1 / m.peRatio : null))
      .filter((v): v is number => v != null);

    groups.push({
      id,
      sizeLog: sizeSum > 0 ? Math.log10(sizeSum) : 0,
      medRevG: median(revGs),
      medRoe: median(roes),
      medEy: median(eys),
      speculative,
    });
  }

  const sizeR = rank01(
    groups.map((g) => (g.speculative ? g.sizeLog * 0.5 : g.sizeLog)),
    true,
  );
  const growthR = rank01(groups.map((g) => g.medRevG), true);
  const qualityR = rank01(groups.map((g) => g.medRoe), true);
  const cheapR = rank01(groups.map((g) => g.medEy), true);

  const out = new Map<string, number>();
  const w = SECTOR_OPP_COMPONENT_WEIGHTS;
  groups.forEach((g, i) => {
    const size = sizeR[i] ?? 0.5;
    const prosp = ((growthR[i] ?? 0.5) + (qualityR[i] ?? 0.5)) / 2;
    const cheap = cheapR[i] ?? 0.5;
    const s01 = w.size * size + w.prospects * prosp + w.cheap * cheap;
    out.set(g.id, 50 + (s01 - 0.5) * 100);
  });
  return out;
}

/** Map sector scores onto company score mean/std so λ is interpretable. */
export function calibrateSectorToCompany(
  sectorByGroup: Map<string, number>,
  companyScores: number[],
): Map<string, number> {
  const secVals = [...sectorByGroup.values()];
  if (secVals.length === 0 || companyScores.length === 0) return new Map(sectorByGroup);

  const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
  const std = (xs: number[], m: number) => {
    const v = xs.reduce((a, b) => a + (b - m) ** 2, 0) / xs.length;
    return Math.sqrt(v) || 1;
  };
  const secMean = mean(secVals);
  const coMean = mean(companyScores);
  const secStd = std(secVals, secMean);
  const coStd = std(companyScores, coMean);

  const out = new Map<string, number>();
  for (const [id, s] of sectorByGroup) {
    out.set(id, coMean + ((s - secMean) / secStd) * coStd);
  }
  return out;
}

export function blendCompanyWithSector(
  companyScore: number | null,
  sectorScore: number | null,
  lambda: number = SECTOR_LAYER_WEIGHT,
): number | null {
  if (companyScore == null) return null;
  if (sectorScore == null || lambda <= 0) return companyScore;
  return parseFloat(((1 - lambda) * companyScore + lambda * sectorScore).toFixed(2));
}

/**
 * Full pipeline: raw → calibrate → per-ticker blend.
 * Mutates nothing; returns sector score by peer group (calibrated) + blended totals aligned to input order.
 */
export function applySectorLayerToScores(args: {
  rows: SectorLayerRow[];
  companyScores: (number | null)[];
  peerGroupIds: (string | null)[];
  lambda?: number;
}): {
  sectorByGroup: Map<string, number>;
  blendedScores: (number | null)[];
  sectorScores: (number | null)[];
} {
  const lambda = args.lambda ?? SECTOR_LAYER_WEIGHT;
  const raw = computeRawPeerGroupOpportunity(args.rows);
  const companyNums = args.companyScores.filter((v): v is number => v != null && Number.isFinite(v));
  const sectorByGroup = calibrateSectorToCompany(raw, companyNums);
  const coMean =
    companyNums.length > 0 ? companyNums.reduce((a, b) => a + b, 0) / companyNums.length : 50;

  const sectorScores = args.peerGroupIds.map((gid) =>
    gid && sectorByGroup.has(gid) ? sectorByGroup.get(gid)! : null,
  );
  const blendedScores = args.companyScores.map((co, i) => {
    const sec = sectorScores[i] ?? coMean;
    return blendCompanyWithSector(co, sec, lambda);
  });

  return { sectorByGroup, blendedScores, sectorScores };
}
