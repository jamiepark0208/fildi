/**
 * IV-rank resolver before/after (Jamie 10-24, lab O2): champion ivRelative on the RV proxy vs the resolver's true IV percentile
 * (watchlist_sync.iv_rank_daily: LSEG → tastytrade). Re-scores each stored best strike with its stored components, swapping ivRelative.
 * Usage: cd artifacts/api-server && pnpm exec tsx --env-file=../../.env.local src/scripts/ivrank-before-after.ts [--side call]
 */
import { pool } from "@workspace/db";
import { scoreIvRelative, type TechnicalRow } from "@workspace/option-scoring";
import { getAllTechnicalsRows } from "../lib/technicals-db.js";
import { loadIvRanks } from "../lib/put-scoring-inputs.js";

const SIDE: "put" | "call" = process.argv.includes("--side") && process.argv[process.argv.indexOf("--side") + 1] === "call" ? "call" : "put";
type Comp = Record<string, { score: number | null; weight: number }>;
const n = (v: unknown) => (v == null || !Number.isFinite(Number(v)) ? null : Number(v));

function weighted(c: Comp, over: Record<string, number | null>): number | null {
  let num = 0, den = 0;
  for (const [k, v] of Object.entries(c)) {
    const s = k in over ? over[k] : v?.score ?? null;
    if (s == null || !Number.isFinite(s) || !v?.weight) continue;
    num += s * v.weight; den += v.weight;
  }
  return den > 0 ? (num / den) * 100 : null;
}

function spearman(a: number[], b: number[]): number {
  const rank = (x: number[]) => { const o = x.map((v, i) => [v, i] as const).sort((p, q) => p[0] - q[0]); const r = new Array(x.length); o.forEach(([, i], k) => (r[i] = k)); return r as number[]; };
  const ra = rank(a), rb = rank(b), m = (a.length - 1) / 2;
  let sxy = 0, sxx = 0, syy = 0;
  for (let i = 0; i < a.length; i++) { sxy += (ra[i]! - m) * (rb[i]! - m); sxx += (ra[i]! - m) ** 2; syy += (rb[i]! - m) ** 2; }
  return sxy / Math.sqrt(sxx * syy);
}

async function main() {
  const tech = new Map(((await getAllTechnicalsRows()) as unknown as TechnicalRow[]).map((r) => [r.ticker, r as unknown as Record<string, unknown>]));
  const ivr = await loadIvRanks();
  const { rows: snaps } = await pool.query(`
    SELECT ticker, option_score::float8 AS score, component_scores FROM option_score_snapshots
    WHERE side = $1 AND as_of = (SELECT max(as_of) FROM option_score_snapshots WHERE side = $1)`, [SIDE]);
  const out: { t: string; before: number; after: number; proxy: number | null; real: number | null }[] = [];
  for (const s of snaps as { ticker: string; score: number; component_scores: Comp }[]) {
    const c = s.component_scores ?? {};
    const tr = tech.get(s.ticker) ?? {};
    const real = ivr.get(s.ticker) ?? null;
    const ivNew = scoreIvRelative(real, null, n(tr.ivVsRealizedVol), n(tr.basicSkew), SIDE === "call");
    const rawOld = weighted(c, {}), rawNew = weighted(c, { ivRelative: ivNew });
    if (rawOld == null || rawNew == null || rawOld <= 0) continue;
    out.push({ t: s.ticker, before: s.score, after: s.score * (rawNew / rawOld), proxy: n(tr.ivRank), real });
  }
  const by = (k: "before" | "after") => [...out].sort((a, b) => b[k] - a[k]);
  const top = (k: "before" | "after", m: number) => new Set(by(k).slice(0, m).map((x) => x.t));
  const ov = (m: number) => [...top("before", m)].filter((t) => top("after", m).has(t)).length;
  const both = out.filter((x) => x.proxy != null && x.real != null);
  console.log(`IV-rank resolver before/after · ${SIDE} · n ${out.length} · real IV pctile for ${out.filter((x) => x.real != null).length}`);
  console.log(`proxy vs real IV pctile Spearman (n ${both.length}): ${spearman(both.map((x) => x.proxy!), both.map((x) => x.real!)).toFixed(2)}`);
  console.log(`rank corr old vs new option score: ${spearman(out.map((x) => x.before), out.map((x) => x.after)).toFixed(3)}`);
  console.log(`top-10 overlap ${ov(10)}/10 · top-20 ${ov(20)}/20 · top-40 ${ov(40)}/40`);
  const fmt = (x: typeof out[number]) => `${x.t} ${x.before.toFixed(1)}→${x.after.toFixed(1)}`;
  console.log("top-20 before:", by("before").slice(0, 20).map((x) => x.t).join(" "));
  console.log("top-20 after: ", by("after").slice(0, 20).map((x) => x.t).join(" "));
  const moves = [...out].sort((a, b) => (b.after - b.before) - (a.after - a.before));
  console.log("biggest up:  ", moves.slice(0, 8).map(fmt).join(" · "));
  console.log("biggest down:", moves.slice(-8).reverse().map(fmt).join(" · "));
  await pool.end();
}

main().catch((e) => { console.error(e); process.exit(1); });
