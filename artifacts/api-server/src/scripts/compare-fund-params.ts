/**
 * Before/after for a fund-score parameter change — read-only (dry-run of the production pipeline, no writes).
 * Champion vs the latest 'challenger' row in scorecard_params (lane "fund"), or a JSON override merged onto the
 * champion. Prints score/rank shifts, top-50 turnover, biggest movers and metric coverage. Promotion is the
 * user's call (AGENTS.md rule 5); paste this output into the approval.
 *
 *   pnpm exec tsx src/scripts/compare-fund-params.ts
 *   pnpm exec tsx src/scripts/compare-fund-params.ts '{"metricBaseIntra":{"ibesFwdGrowth":2.5}}'
 */
import { pool } from "@workspace/db";
import { computeAndPersistFundamentalScores, type FundScoreResult } from "../lib/fundamentals-db.js";
import { getChampionScorecardParams } from "../lib/scorecard-params.js";
import { getLatestRegime } from "../routes/regime.js";

function merge(base: Record<string, unknown>, over: Record<string, unknown>): Record<string, unknown> {
  const out = { ...base };
  for (const [k, v] of Object.entries(over)) {
    out[k] = v && typeof v === "object" && !Array.isArray(v) && out[k] && typeof out[k] === "object"
      ? merge(out[k] as Record<string, unknown>, v as Record<string, unknown>) : v;
  }
  return out;
}

function spearman(a: number[], b: number[]): number {
  const rank = (x: number[]) => { const o = x.map((v, i) => [v, i] as const).sort((p, q) => p[0] - q[0]); const r = new Array(x.length); o.forEach(([, i], k) => (r[i] = k)); return r as number[]; };
  const ra = rank(a), rb = rank(b), n = a.length, m = (n - 1) / 2;
  let num = 0, da = 0, db = 0;
  for (let i = 0; i < n; i++) { num += (ra[i]! - m) * (rb[i]! - m); da += (ra[i]! - m) ** 2; db += (rb[i]! - m) ** 2; }
  return num / Math.sqrt(da * db);
}

async function main() {
  const champ = await getChampionScorecardParams("fund");
  let chal: { version: string; params: Record<string, unknown> };
  if (process.argv[2]) {
    chal = { version: `${champ.version}+override`, params: merge(champ.params, JSON.parse(process.argv[2])) };
  } else {
    const { rows } = await pool.query(`SELECT version, params FROM scorecard_params WHERE lane='fund' AND status='challenger' ORDER BY created_at DESC LIMIT 1`);
    if (!rows[0]) throw new Error("no fund challenger row; pass a JSON override");
    chal = { version: rows[0].version, params: merge(champ.params, rows[0].params) };
  }
  const regime = await getLatestRegime();
  const a = await computeAndPersistFundamentalScores(regime, "admin_recompute", { paramsOverride: champ, dryRun: true });
  const b = await computeAndPersistFundamentalScores(regime, "admin_recompute", { paramsOverride: chal, dryRun: true });
  const byB = new Map(b.map((r) => [r.ticker, r]));
  const pairs = a.filter((r) => r.totalScore != null && byB.get(r.ticker)?.totalScore != null)
    .map((r) => ({ t: r.ticker, a: r.totalScore!, b: byB.get(r.ticker)!.totalScore!, style: r.styleBucket, ra: r.rank, rb: byB.get(r.ticker)!.rank }));
  const d = pairs.map((p) => p.b - p.a).sort((x, y) => x - y);
  const q = (f: number) => d[Math.min(d.length - 1, Math.floor(f * d.length))]!.toFixed(2);
  const top = (rs: FundScoreResult[]) => new Set(rs.filter((r) => r.totalScore != null).sort((x, y) => y.totalScore! - x.totalScore!).slice(0, 50).map((r) => r.ticker));
  const ta = top(a), tb = top(b);
  const metricCover = b.filter((r) => r.metricScores?.["ibesFwdGrowth"]?.value != null).length;
  console.log(JSON.stringify({
    champion: champ.version, challenger: chal.version,
    scored: { champion: a.filter((r) => r.totalScore != null).length, challenger: b.filter((r) => r.totalScore != null).length },
    scoreShift: { p05: q(0.05), p25: q(0.25), median: q(0.5), p75: q(0.75), p95: q(0.95), meanAbs: (d.reduce((s, x) => s + Math.abs(x), 0) / d.length).toFixed(2) },
    rankCorrelation: spearman(pairs.map((p) => p.a), pairs.map((p) => p.b)).toFixed(4),
    top50: { kept: [...ta].filter((t) => tb.has(t)).length, entered: [...tb].filter((t) => !ta.has(t)), left: [...ta].filter((t) => !tb.has(t)) },
    ibesFwdGrowthCoverage: `${metricCover}/${b.length}`,
  }, null, 2));
  const mv = [...pairs].sort((x, y) => Math.abs(y.b - y.a) - Math.abs(x.b - x.a)).slice(0, 15);
  console.log("\nbiggest movers (score champion → challenger):");
  for (const p of mv) console.log(`  ${p.t.padEnd(6)} ${p.a.toFixed(1).padStart(5)} → ${p.b.toFixed(1).padStart(5)}  (${p.style ?? "—"})`);
  const byStyle: Record<string, number[]> = {};
  for (const p of pairs) (byStyle[p.style ?? "none"] ??= []).push(p.b - p.a);
  console.log("\nmean shift by style: " + Object.entries(byStyle).map(([k, v]) => `${k} ${(v.reduce((s, x) => s + x, 0) / v.length).toFixed(2)} (n ${v.length})`).join(" · "));
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
