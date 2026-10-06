// PEG growth vs peer-group EPS growth (Breakdown "Growth (PEG)" chart). Moved from routes/stocks.ts.
import { inArray } from "drizzle-orm";
import { db, tickerFundamentals } from "@workspace/db";
import { num as fmpNum } from "./fund-derived-metrics.js";
import { getTaxonomyPeers } from "./peer-classifier.js";

/** Z-score of subject's PEG growth vs peer-group gold EPS growth (higher = better). */
export async function pegGrowthPeerZScore(
  ticker: string,
  pegGrowth: number | null | undefined,
): Promise<{
  z: number | null;
  n: number;
  groupName: string | null;
  mean: number | null;
  std: number | null;
  members: Array<{ ticker: string; growth: number; z: number; isSubject: boolean; marketCap: number | null }>;
  display: Array<{ ticker: string; growth: number; z: number; isSubject: boolean; marketCap: number | null }>;
}> {
  const empty = {
    z: null as number | null,
    n: 0,
    groupName: null as string | null,
    mean: null as number | null,
    std: null as number | null,
    members: [] as Array<{ ticker: string; growth: number; z: number; isSubject: boolean; marketCap: number | null }>,
    display: [] as Array<{ ticker: string; growth: number; z: number; isSubject: boolean; marketCap: number | null }>,
  };
  if (pegGrowth == null || !isFinite(pegGrowth)) return empty;

  const taxonomy = await getTaxonomyPeers(ticker, 500);
  if (!taxonomy || taxonomy.peers.length < 3) {
    return { ...empty, groupName: taxonomy?.groupName ?? null };
  }

  const subject = ticker.toUpperCase();
  const tickers = [subject, ...taxonomy.peers.map((t) => t.toUpperCase())];
  const rows = await db
    .select({
      ticker: tickerFundamentals.ticker,
      epsGrowth: tickerFundamentals.epsGrowth,
      totalRevenue: tickerFundamentals.totalRevenue,
    })
    .from(tickerFundamentals)
    .where(inArray(tickerFundamentals.ticker, tickers));

  type Raw = { ticker: string; growth: number; isSubject: boolean; size: number | null };
  const raw: Raw[] = [];
  for (const r of rows) {
    const upper = r.ticker.toUpperCase();
    const size = fmpNum(r.totalRevenue);
    if (upper === subject) {
      raw.push({ ticker: upper, growth: pegGrowth, isSubject: true, size });
      continue;
    }
    const v = fmpNum(r.epsGrowth);
    if (v != null && isFinite(v)) {
      raw.push({ ticker: upper, growth: v, isSubject: false, size });
    }
  }
  if (raw.length < 4) {
    return { ...empty, n: raw.length, groupName: taxonomy.groupName };
  }

  const vals = raw.map((r) => r.growth);
  const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
  const variance = vals.reduce((a, b) => a + (b - mean) ** 2, 0) / vals.length;
  const std = Math.sqrt(variance);
  const zOf = (g: number) => (std > 1e-12 ? (g - mean) / std : 0);
  const members = raw
    .map((r) => ({
      ticker: r.ticker,
      growth: r.growth,
      z: zOf(r.growth),
      isSubject: r.isSubject,
      marketCap: r.size, // size proxy = total revenue (gold has no marketCap)
    }))
    .sort((a, b) => a.growth - b.growth);

  const subjectZ = zOf(pegGrowth);
  // Representatives when the peer set is large: subject + growth extremes + largest names
  const display = pickPeerGrowthRepresentatives(members, 9);

  return {
    z: subjectZ,
    n: members.length,
    groupName: taxonomy.groupName,
    mean,
    std,
    members,
    display,
  };
}

/** Subject + lowest/highest growth + largest-revenue peers (cap labeled points). */
export function pickPeerGrowthRepresentatives<
  T extends { ticker: string; growth: number; z: number; isSubject: boolean; marketCap: number | null },
>(members: T[], max = 9): T[] {
  if (members.length <= max) return members;
  const byGrowth = [...members].sort((a, b) => a.growth - b.growth);
  const bySize = [...members]
    .filter((m) => !m.isSubject)
    .sort((a, b) => (b.marketCap ?? 0) - (a.marketCap ?? 0));
  const picked = new Map<string, T>();
  const add = (m: T | undefined) => {
    if (m && !picked.has(m.ticker)) picked.set(m.ticker, m);
  };
  add(byGrowth.find((m) => m.isSubject));
  add(byGrowth[0]);
  add(byGrowth[byGrowth.length - 1]);
  add(byGrowth[Math.floor(byGrowth.length * 0.25)]);
  add(byGrowth[Math.floor(byGrowth.length * 0.5)]);
  add(byGrowth[Math.floor(byGrowth.length * 0.75)]);
  for (const m of bySize) {
    if (picked.size >= max) break;
    add(m);
  }
  return [...picked.values()].sort((a, b) => a.growth - b.growth);
}
