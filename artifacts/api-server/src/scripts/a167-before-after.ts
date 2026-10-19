/**
 * A167 before/after — options-1.0.0 vs options-1.1.0 on the latest stored put snapshots.
 * Re-scores each stored best strike with its stored components, swapping in:
 *   stockQuality from the put-tuned tech score (trend − volumeConfirm) and nodeGap (S045).
 * Calls (A170/S046): `--side call` → call lane tech = low volume + not stretched above the 200-day; strike weights unchanged.
 * Usage: cd artifacts/api-server && pnpm exec tsx --env-file=../../.env.local src/scripts/a167-before-after.ts [--side call]
 */
import { pool } from "@workspace/db";
import { computeTechnicalRankingsV2, scoreStockQuality, scoreNodeGap, SQ_FLOOR_BASE, CALL_STRIKE_WEIGHTS, type TechnicalRow } from "@workspace/option-scoring";
import { getAllTechnicalsRows } from "../lib/technicals-db.js";
import { loadVolumeNodes, laneTechScores } from "../lib/put-scoring-inputs.js";

export const PUT_TECH_WEIGHTS_1_1 = {
  oversoldDepth: 0, reversalSignal: 0, volatilityState: 0, trendContext: 0.5,
  optionsFlow: 0, relativePressure: 0, analystUpside: 0, volumeConfirm: -0.5,
};
export const CALL_TECH_WEIGHTS_1_2 = {
  oversoldDepth: 0, reversalSignal: 0, volatilityState: 0, trendContext: 0,
  optionsFlow: 0, relativePressure: 0, analystUpside: 0, volumeConfirm: -0.5, ma200Stretch: -0.5,
};
const SIDE: "put" | "call" = process.argv.includes("--side") && process.argv[process.argv.indexOf("--side") + 1] === "call" ? "call" : "put";
const PUT_OLD_W: Record<string, number> = { income: 0.30, buffer: 0.32, ivRelative: 0.10, ivAbsolute: 0.06, stockQuality: 0.12, support: 0.06, dte: 0.04 };
const OLD_W: Record<string, number> = SIDE === "call" ? { ...PUT_OLD_W, ...CALL_STRIKE_WEIGHTS } : PUT_OLD_W; // calls override income/buffer only
const NEW_W: Record<string, number> = SIDE === "call" ? OLD_W : { ...PUT_OLD_W, support: 0, nodeGap: 0.06 };

type Comp = Record<string, { score: number | null; weight: number }>;

function weighted(c: Record<string, number | null>, w: Record<string, number>): number | null {
  let num = 0, den = 0;
  for (const [k, wt] of Object.entries(w)) {
    const s = c[k];
    if (s == null || !Number.isFinite(s) || wt === 0) continue;
    num += s * wt; den += wt;
  }
  return den > 0 ? (num / den) * 100 : null;
}

function spearman(a: number[], b: number[]): number {
  const rank = (x: number[]) => { const o = x.map((v, i) => [v, i] as const).sort((p, q) => p[0] - q[0]); const r = new Array(x.length); o.forEach(([, i], k) => (r[i] = k)); return r as number[]; };
  const ra = rank(a), rb = rank(b), n = a.length, m = (n - 1) / 2;
  let sxy = 0, sxx = 0, syy = 0;
  for (let i = 0; i < n; i++) { sxy += (ra[i]! - m) * (rb[i]! - m); sxx += (ra[i]! - m) ** 2; syy += (rb[i]! - m) ** 2; }
  return sxy / Math.sqrt(sxx * syy);
}

async function main() {
  const rows = (await getAllTechnicalsRows()) as unknown as TechnicalRow[];
  const oldTech = new Map(computeTechnicalRankingsV2(rows, {}, undefined, SIDE).map((s) => [s.ticker, s.totalScore]));
  const newTech = laneTechScores(rows, SIDE === "call" ? CALL_TECH_WEIGHTS_1_2 : PUT_TECH_WEIGHTS_1_1, SIDE);

  const { rows: snaps } = await pool.query(`
    SELECT ticker, strike::float8 AS strike, spot::float8 AS spot, option_score::float8 AS score, component_scores
    FROM option_score_snapshots
    WHERE side = $1 AND as_of = (SELECT max(as_of) FROM option_score_snapshots WHERE side = $1)`, [SIDE]);
  const { rows: [{ as_of }] } = await pool.query(`SELECT max(as_of)::text AS as_of FROM option_score_snapshots WHERE side = $1`, [SIDE]);
  const nodes = await loadVolumeNodes(snaps.map((s: { ticker: string }) => s.ticker));

  const out: { t: string; before: number; after: number; sqOld: number | null; sqNew: number | null; gap: number | null }[] = [];
  for (const s of snaps as { ticker: string; strike: number; spot: number; score: number; component_scores: Comp }[]) {
    const c: Record<string, number | null> = {};
    for (const [k, v] of Object.entries(s.component_scores ?? {})) c[k] = v?.score ?? null;
    const tOld = oldTech.get(s.ticker) ?? null, tNew = newTech.get(s.ticker) ?? null;
    // Recover the fund score the stored stockQuality used (sq = 0.6·tech + 0.4·fund).
    const sqStored = c.stockQuality ?? null;
    let fund: number | null = null;
    if (sqStored != null && tOld != null) fund = Math.max(0, Math.min(100, (sqStored * 100 - 0.6 * tOld) / 0.4));
    else if (sqStored != null && tOld == null) fund = sqStored * 100;
    const sqNew = scoreStockQuality(tNew, fund);
    const gap = SIDE === "call" ? null : scoreNodeGap(s.strike, s.spot, nodes.get(s.ticker));
    const rawOld = weighted(c, OLD_W);
    const rawNew = weighted({ ...c, stockQuality: sqNew, nodeGap: gap }, NEW_W);
    if (rawOld == null || rawNew == null || rawOld <= 0) continue;
    // Keep stored haircuts/calibration: scale the stored score by the raw ratio.
    out.push({ t: s.ticker, before: s.score, after: s.score * (rawNew / rawOld), sqOld: sqStored, sqNew, gap });
  }

  const by = (k: "before" | "after") => [...out].sort((a, b) => b[k] - a[k]);
  const top = (k: "before" | "after", n: number) => new Set(by(k).slice(0, n).map((x) => x.t));
  const ov = (n: number) => [...top("before", n)].filter((t) => top("after", n).has(t)).length;
  const below = (k: "sqOld" | "sqNew") => out.filter((x) => x[k] != null && x[k]! < SQ_FLOOR_BASE).length;
  const gaps = out.filter((x) => x.gap != null);
  console.log(`A167/A170 before/after · ${SIDE} snapshots as_of ${as_of} · n ${out.length}`);
  console.log(`rank corr old vs new option score: ${spearman(out.map((x) => x.before), out.map((x) => x.after)).toFixed(3)}`);
  console.log(`top-10 overlap ${ov(10)}/10 · top-20 ${ov(20)}/20 · top-40 ${ov(40)}/40`);
  console.log(`stockQuality < floor ${SQ_FLOOR_BASE}: before ${below("sqOld")} · after ${below("sqNew")} (gate drops a candidate)`);
  console.log("newly gated:", out.filter((x) => x.sqNew != null && x.sqNew < SQ_FLOOR_BASE && !(x.sqOld != null && x.sqOld < SQ_FLOOR_BASE)).map((x) => x.t).join(" "));
  console.log(`nodeGap known ${gaps.length}/${out.length}; node between strike and spot: ${gaps.filter((x) => x.gap === 0).length}`);
  const fmt = (x: typeof out[number]) => `${x.t} ${x.before.toFixed(1)}→${x.after.toFixed(1)}`;
  console.log("top-20 before:", by("before").slice(0, 20).map((x) => x.t).join(" "));
  console.log("top-20 after: ", by("after").slice(0, 20).map((x) => x.t).join(" "));
  const moves = [...out].sort((a, b) => (b.after - b.before) - (a.after - a.before));
  console.log("biggest up:  ", moves.slice(0, 8).map(fmt).join(" · "));
  console.log("biggest down:", moves.slice(-8).reverse().map(fmt).join(" · "));
  await pool.end();
}

main().catch((e) => { console.error(e); process.exit(1); });
