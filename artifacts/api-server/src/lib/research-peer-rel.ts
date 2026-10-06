/**
 * Peer-relative research context for WRDS/LSEG reports.
 * Uses taxonomy peer_group_members (same cohort as fund scoring) + local research caches.
 */
import { pool } from "@workspace/db";
import { getTaxonomyPeers } from "./peer-classifier.js";
import { ibesRevBreadth, avgIbesSue } from "./fund-derived-metrics.js";

export type RelMetric = {
  value: number | null;
  peerMedian: number | null;
  /** 0–100 percentile among peers with data (higher = larger raw value). */
  peerPct: number | null;
  n: number;
  deltaVsMedian: number | null;
};

export type PeerLeader = { ticker: string; value: number };

export type PeerRelativeBlock = {
  groupId: string | null;
  groupName: string | null;
  sector: string | null;
  peerCount: number;
  sampleN: number;
  metrics: Record<string, RelMetric>;
  /** Top peers on the primary metric (breadth for WRDS, combined α for LSEG). */
  leaders: PeerLeader[];
  note: string;
};

function median(nums: number[]): number | null {
  if (nums.length === 0) return null;
  const s = [...nums].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

/** Percentile of `value` within `vals` (0–100). Ties → mid-rank. */
function percentile(value: number, vals: number[]): number | null {
  if (vals.length === 0) return null;
  const below = vals.filter((v) => v < value).length;
  const equal = vals.filter((v) => v === value).length;
  return ((below + equal * 0.5) / vals.length) * 100;
}

function pack(value: number | null, peerVals: number[]): RelMetric {
  if (value == null || !Number.isFinite(value)) {
    return { value: null, peerMedian: median(peerVals), peerPct: null, n: peerVals.length, deltaVsMedian: null };
  }
  const med = median(peerVals);
  return {
    value,
    peerMedian: med,
    peerPct: percentile(value, peerVals),
    n: peerVals.length,
    deltaVsMedian: med != null ? value - med : null,
  };
}

async function peerUniverse(ticker: string): Promise<{
  groupId: string | null;
  groupName: string | null;
  sector: string | null;
  peers: string[];
}> {
  const tax = await getTaxonomyPeers(ticker, 48);
  if (!tax || tax.peers.length === 0) {
    return { groupId: null, groupName: null, sector: null, peers: [] };
  }
  const sector = tax.groupId.includes(".") ? tax.groupId.split(".")[0]! : tax.groupId;
  return {
    groupId: tax.groupId,
    groupName: tax.groupName,
    sector,
    peers: tax.peers,
  };
}

/** Map tickers → IBES oftic (fallback ticker). */
async function ofticMap(tickers: string[]): Promise<Map<string, string>> {
  if (tickers.length === 0) return new Map();
  const r = await pool.query<{ ticker: string; ibes_oftic: string | null }>(
    `SELECT ticker, ibes_oftic FROM research_common.security_map WHERE ticker = ANY($1::text[])`,
    [tickers],
  ).catch(() => ({ rows: [] as { ticker: string; ibes_oftic: string | null }[] }));
  const m = new Map<string, string>();
  for (const t of tickers) m.set(t, t);
  for (const row of r.rows) {
    m.set(row.ticker.toUpperCase(), (row.ibes_oftic || row.ticker).toUpperCase());
  }
  return m;
}

export async function wrdsPeerRelative(
  ticker: string,
  self: { breadth: number | null; sue: number | null; meanest: number | null },
): Promise<PeerRelativeBlock> {
  const u = await peerUniverse(ticker);
  const empty: PeerRelativeBlock = {
    groupId: u.groupId,
    groupName: u.groupName,
    sector: u.sector,
    peerCount: u.peers.length,
    sampleN: 0,
    metrics: {},
    leaders: [],
    note: u.peers.length
      ? "Peer cohort = taxonomy peer_group_members (same as fund scoring)."
      : "No taxonomy peer group — absolute IBES only.",
  };
  if (u.peers.length === 0) return empty;

  const all = [ticker.toUpperCase(), ...u.peers];
  const oftics = await ofticMap(all);
  const ofticList = [...new Set([...oftics.values()])];

  const [stats, surp] = await Promise.all([
    pool.query<{ oftic: string; numup: number | null; numdown: number | null; numest: number | null; meanest: number | null }>(
      `SELECT DISTINCT ON (oftic) oftic, numup, numdown, numest, meanest
       FROM wrds_research.ibes_statsum
       WHERE oftic = ANY($1::text[]) AND measure = 'EPS'
       ORDER BY oftic,
         CASE WHEN fpi IN ('1','1.0') THEN 0 ELSE 1 END,
         CASE WHEN fiscalp IN ('ANN','Y') THEN 0 ELSE 1 END,
         statpers DESC`,
      [ofticList],
    ).catch(() => ({ rows: [] as never[] })),
    pool.query<{ oftic: string; suescore: number | null }>(
      `SELECT oftic, suescore FROM wrds_research.ibes_surpsum
       WHERE oftic = ANY($1::text[]) AND suescore IS NOT NULL
       ORDER BY oftic, anndats DESC NULLS LAST`,
      [ofticList],
    ).catch(() => ({ rows: [] as never[] })),
  ]);

  const breadthByOftic = new Map<string, number>();
  const meanByOftic = new Map<string, number>();
  for (const r of stats.rows) {
    const b = ibesRevBreadth(r.numup, r.numdown, r.numest);
    if (b != null) breadthByOftic.set(r.oftic.toUpperCase(), b);
    if (r.meanest != null && Number.isFinite(Number(r.meanest))) {
      meanByOftic.set(r.oftic.toUpperCase(), Number(r.meanest));
    }
  }
  const sueLists = new Map<string, number[]>();
  for (const r of surp.rows) {
    const o = r.oftic.toUpperCase();
    if (!sueLists.has(o)) sueLists.set(o, []);
    const arr = sueLists.get(o)!;
    if (arr.length < 4 && r.suescore != null) arr.push(Number(r.suescore));
  }

  const peerBreadth: number[] = [];
  const peerSue: number[] = [];
  const leaders: PeerLeader[] = [];
  let sampleN = 0;

  for (const p of u.peers) {
    const o = oftics.get(p) ?? p;
    const b = breadthByOftic.get(o);
    const sue = avgIbesSue(sueLists.get(o) ?? []);
    if (b != null || sue != null) sampleN++;
    if (b != null) {
      peerBreadth.push(b);
      leaders.push({ ticker: p, value: b });
    }
    if (sue != null) peerSue.push(sue);
  }
  if (self.breadth != null) {
    leaders.push({ ticker: ticker.toUpperCase(), value: self.breadth });
  }

  leaders.sort((a, b) => b.value - a.value);

  return {
    ...empty,
    sampleN,
    metrics: {
      breadth: pack(self.breadth, peerBreadth),
      sue: pack(self.sue, peerSue),
      // meanest absolute $ is not comparable across names — omit peer pack; keep self only for display
      meanest: {
        value: self.meanest,
        peerMedian: null,
        peerPct: null,
        n: 0,
        deltaVsMedian: null,
      },
    },
    leaders: leaders.slice(0, 6),
    note: `Peer cohort = ${u.groupName ?? u.groupId} (${u.peers.length} names, ${sampleN} with IBES cache). Breadth/SUE ranked vs peers — FY1 $ level is not peer-comparable (different share bases).`,
  };
}

export async function lsegPeerRelative(
  ticker: string,
  self: {
    armRank: number | null;
    combinedAlphaRank: number | null;
    predSurprisePct: number | null;
    epsDrift30dPct: number | null;
  },
): Promise<PeerRelativeBlock> {
  const u = await peerUniverse(ticker);
  const empty: PeerRelativeBlock = {
    groupId: u.groupId,
    groupName: u.groupName,
    sector: u.sector,
    peerCount: u.peers.length,
    sampleN: 0,
    metrics: {},
    leaders: [],
    note: u.peers.length
      ? "Peer cohort = taxonomy peer_group_members."
      : "No taxonomy peer group — absolute StarMine only.",
  };
  if (u.peers.length === 0) return empty;

  const peers = u.peers;
  const r = await pool.query<{
    ticker: string;
    arm_rank: number | null;
    combined_alpha_rank: number | null;
    pred_surprise_pct_fq1: number | null;
    eps_drift_30d_pct: number | null;
  }>(
    `SELECT DISTINCT ON (ticker) ticker, arm_rank, combined_alpha_rank, pred_surprise_pct_fq1, eps_drift_30d_pct
     FROM lseg_research.signals_daily
     WHERE ticker = ANY($1::text[])
     ORDER BY ticker, as_of DESC`,
    [peers],
  ).catch(() => ({ rows: [] as never[] }));

  const arm: number[] = [];
  const cam: number[] = [];
  const pred: number[] = [];
  const drift: number[] = [];
  const leaders: PeerLeader[] = [];

  for (const row of r.rows) {
    if (row.arm_rank != null) arm.push(Number(row.arm_rank));
    if (row.combined_alpha_rank != null) {
      const v = Number(row.combined_alpha_rank);
      cam.push(v);
      leaders.push({ ticker: row.ticker.toUpperCase(), value: v });
    }
    if (row.pred_surprise_pct_fq1 != null) pred.push(Number(row.pred_surprise_pct_fq1));
    if (row.eps_drift_30d_pct != null) drift.push(Number(row.eps_drift_30d_pct));
  }
  if (self.combinedAlphaRank != null) {
    leaders.push({ ticker: ticker.toUpperCase(), value: self.combinedAlphaRank });
  }
  leaders.sort((a, b) => b.value - a.value);

  return {
    ...empty,
    sampleN: r.rows.length,
    metrics: {
      armRank: pack(self.armRank, arm),
      combinedAlphaRank: pack(self.combinedAlphaRank, cam),
      predSurprisePct: pack(self.predSurprisePct, pred),
      epsDrift30dPct: pack(self.epsDrift30dPct, drift),
    },
    leaders: leaders.slice(0, 6),
    note: `Peer cohort = ${u.groupName ?? u.groupId} (${u.peers.length} names, ${r.rows.length} with LSEG signals). Ranks/drift/pred-surprise vs peer median + percentile.`,
  };
}
