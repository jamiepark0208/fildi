/**
 * A148 — apply Jamie-approved peer moves (S038 OpenJev audit) as peer_group_overrides,
 * with fund-score before/after (AGENTS rule 7).
 * Held: ZTO TCOM (China scoring mode is tied to technology.chinese_tech; Jamie's caveat = keep
 * the China lens, so they wait for a separate China flag). COST already in Retail.
 * Usage: cd artifacts/api-server && pnpm exec tsx src/scripts/a148-peer-moves.ts [--apply]
 */
import { computeAndPersistFundamentalScores, type FundScoreResult } from "../lib/fundamentals-db.js";
import { setPeerGroupOverride } from "../lib/peer-classifier.js";
import { getLatestRegime } from "../routes/regime.js";

const MOVES: Record<string, string[]> = {
  "consumer_staples.packaged_goods_beverages": ["CPB", "CAG", "GIS", "HRL", "HSY", "KHC", "MDLZ", "SJM", "COTY"],
  "industrials.aerospace_defense": ["GE"],
  "financials.regional_banks": ["TFC", "PNC"],
  "technology.semiconductor_foundry_specialty": ["GFS"],
  "utilities.water_gas_multi_utilities": ["ATO"],
  "healthcare.speculative_biotech": ["CABA"],
  "consumer_discretionary.restaurants_food_service": ["SG", "REBN"],
  "technology.enterprise_software_cloud": ["BB", "SOUN"],
  "fintech.digital_finance_payments": ["BULL"],
  "financials.asset_management_alt_finance": ["STT", "BK"],
  "healthcare.large_pharma": ["GILD", "AMGN", "BIIB"],
};
const apply = process.argv.includes("--apply");
const regime = await getLatestRegime();
const byTicker = (rs: FundScoreResult[]) => new Map(rs.map((r) => [r.ticker, r]));

const before = byTicker(await computeAndPersistFundamentalScores(regime, "peer_override", { dryRun: true }));
if (apply) {
  for (const [group, tickers] of Object.entries(MOVES)) {
    for (const t of tickers) await setPeerGroupOverride(t, group, "A148 S038 OpenJev audit, Jamie OK 2026-10-18");
  }
}
const after = byTicker(await computeAndPersistFundamentalScores(regime, "peer_override", { dryRun: !apply }));

const f = (v: number | null | undefined) => (v == null ? "n/a" : v.toFixed(1));
const moved = new Set(Object.values(MOVES).flat());
const rows: string[] = [];
let changedOthers = 0;
for (const [t, a] of after) {
  const b = before.get(t);
  const d = (a.totalScore ?? NaN) - (b?.totalScore ?? NaN);
  if (moved.has(t)) rows.push(`${t}\t${f(b?.totalScore)} → ${f(a.totalScore)}\tV ${f(b?.valueScore)}→${f(a.valueScore)} Q ${f(b?.qualityScore)}→${f(a.qualityScore)} G ${f(b?.growthScore)}→${f(a.growthScore)} S ${f(b?.safetyScore)}→${f(a.safetyScore)}`);
  else if (Number.isFinite(d) && Math.abs(d) >= 0.05) changedOthers++;
}
console.log(`${apply ? "APPLIED" : "DRY RUN"} · moved ${moved.size}\n` + rows.sort().join("\n"));
console.log(`other tickers whose total moved ≥ 0.05 (peer medians shift): ${changedOthers}`);
process.exit(0);
