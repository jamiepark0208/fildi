/**
 * Before/after for a fair-value parameter change — read-only, writes nothing.
 * Runs the champion and a challenger (scorecard_params lane "fair_value", status 'challenger', or a JSON
 * override) on the SAME production inputs and prints coverage, distribution, extremes and the biggest movers.
 * Promotion stays a user decision (AGENTS.md rule 5); paste this output into the approval.
 *
 *   pnpm exec tsx src/scripts/compare-fair-value-params.ts                       # latest challenger row
 *   pnpm exec tsx src/scripts/compare-fair-value-params.ts '{"growthCap":0.15}'   # ad-hoc override on champion
 */
import { pool } from "@workspace/db";
import { computeFairValues, type FairValueParams, type FairValueResult } from "../lib/fair-value.js";
import { getChampionScorecardParams } from "../lib/scorecard-params.js";
import { loadInputs, loadMarket } from "../lib/fair-value-snapshots.js";

function stats(rs: FairValueResult[]) {
  const v = rs.filter((r) => r.fairValue != null);
  const ratio = v.map((r) => r.fairValue! / r.price!).sort((a, b) => a - b);
  return {
    valued: `${v.length}/${rs.length}`,
    medianFairToPrice: ratio.length ? ratio[ratio.length >> 1]!.toFixed(3) : "—",
    within25pct: ratio.length ? `${Math.round((100 * ratio.filter((x) => x >= 0.75 && x <= 1.25).length) / ratio.length)}%` : "—",
    above3x: ratio.filter((x) => x > 3).length,
    below1_3: ratio.filter((x) => x < 1 / 3).length,
    confidence: v.reduce<Record<string, number>>((a, r) => ({ ...a, [r.confidence!]: (a[r.confidence!] ?? 0) + 1 }), {}),
  };
}

async function main() {
  const champ = await getChampionScorecardParams("fair_value");
  let label: string;
  let challenger: Record<string, unknown>;
  if (process.argv[2]) {
    label = `champion ${champ.version} + override`;
    challenger = { ...champ.params, ...JSON.parse(process.argv[2]) };
  } else {
    const { rows } = await pool.query(
      `SELECT version, params FROM scorecard_params WHERE lane = 'fair_value' AND status = 'challenger'
       ORDER BY created_at DESC LIMIT 1`);
    if (!rows[0]) throw new Error("no fair_value challenger row; pass a JSON override instead");
    label = rows[0].version;
    challenger = { ...champ.params, ...rows[0].params };
  }
  const [market, inputs] = await Promise.all([loadMarket(champ.params), loadInputs()]);
  const a = computeFairValues(inputs, market, champ.params as unknown as FairValueParams);
  const b = computeFairValues(inputs, market, challenger as unknown as FairValueParams);
  console.log(JSON.stringify({ champion: { version: champ.version, ...stats(a) }, challenger: { version: label, ...stats(b) } }, null, 2));
  const byB = new Map(b.map((r) => [r.ticker, r]));
  const movers = a.flatMap((r) => {
    const c = byB.get(r.ticker)!;
    if (r.fairValue == null && c.fairValue == null) return [];
    if (r.fairValue == null || c.fairValue == null) return [{ t: r.ticker, a: r.fairValue, b: c.fairValue, d: Infinity }];
    return [{ t: r.ticker, a: r.fairValue, b: c.fairValue, d: Math.abs(Math.log(c.fairValue / r.fairValue)) }];
  }).filter((m) => m.d > 0.001).sort((x, y) => y.d - x.d);
  console.log(`\nchanged: ${movers.length} tickers; biggest movers:`);
  for (const m of movers.slice(0, 20)) console.log(`  ${m.t.padEnd(6)} ${String(m.a ?? "—").padStart(10)} → ${String(m.b ?? "—").padStart(10)}`);
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
