/**
 * Before/after: live DB fund scores vs dry-run with current engine (ibesRevBreadth optional).
 * Does not write scores.
 *
 *   pnpm exec tsx src/scripts/compare-rev-breadth-optional.ts
 */
import { pool } from "@workspace/db";
import { computeAndPersistFundamentalScores } from "../lib/fundamentals-db.js";
import { getChampionScorecardParams } from "../lib/scorecard-params.js";
import { getLatestRegime } from "../routes/regime.js";

function spearman(a: number[], b: number[]): number {
  const rank = (x: number[]) => {
    const o = x.map((v, i) => [v, i] as const).sort((p, q) => p[0] - q[0]);
    const r = new Array(x.length);
    o.forEach(([, i], k) => { r[i] = k; });
    return r as number[];
  };
  const ra = rank(a), rb = rank(b), n = a.length, m = (n - 1) / 2;
  let num = 0, da = 0, db = 0;
  for (let i = 0; i < n; i++) {
    num += (ra[i]! - m) * (rb[i]! - m);
    da += (ra[i]! - m) ** 2;
    db += (rb[i]! - m) ** 2;
  }
  return num / Math.sqrt(da * db);
}

async function main() {
  const { rows: before } = await pool.query<{ ticker: string; s: number }>(
    `SELECT ticker, fund_total_score::float8 AS s FROM ticker_fundamentals WHERE fund_total_score IS NOT NULL`,
  );
  const byBefore = new Map(before.map((r) => [r.ticker, r.s]));
  const regime = await getLatestRegime();
  const champ = await getChampionScorecardParams("fund");
  const after = await computeAndPersistFundamentalScores(regime, "admin_recompute", {
    paramsOverride: champ,
    dryRun: true,
  });
  const pairs = after
    .filter((r) => r.totalScore != null && byBefore.has(r.ticker))
    .map((r) => ({ t: r.ticker, a: byBefore.get(r.ticker)!, b: r.totalScore! }));
  const d = pairs.map((p) => p.b - p.a).sort((x, y) => x - y);
  const q = (f: number) => d[Math.min(d.length - 1, Math.floor(f * d.length))]!;
  const ta = new Set([...byBefore.entries()].sort((x, y) => y[1] - x[1]).slice(0, 50).map(([t]) => t));
  const tb = new Set(
    [...after]
      .filter((r) => r.totalScore != null)
      .sort((x, y) => y.totalScore! - x.totalScore!)
      .slice(0, 50)
      .map((r) => r.ticker),
  );
  console.log(JSON.stringify({
    note: "DB live (ibesRevBreadth required at compute time) → dryRun with optional:true in engine",
    n: pairs.length,
    rankCorrelation: spearman(pairs.map((p) => p.a), pairs.map((p) => p.b)).toFixed(4),
    scoreShift: {
      p05: q(0.05).toFixed(2),
      median: q(0.5).toFixed(2),
      p95: q(0.95).toFixed(2),
      meanAbs: (d.reduce((s, x) => s + Math.abs(x), 0) / d.length).toFixed(2),
    },
    top50: {
      kept: [...ta].filter((t) => tb.has(t)).length,
      entered: [...tb].filter((t) => !ta.has(t)),
      left: [...ta].filter((t) => !tb.has(t)),
    },
    biggest: [...pairs]
      .sort((x, y) => Math.abs(y.b - y.a) - Math.abs(x.b - x.a))
      .slice(0, 12)
      .map((p) => `${p.t} ${p.a.toFixed(1)}→${p.b.toFixed(1)}`),
  }, null, 2));
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
