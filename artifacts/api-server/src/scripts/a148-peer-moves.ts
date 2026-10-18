/**
 * A148 — apply Jamie-approved peer moves (S038 OpenJev audit) as peer_group_overrides,
 * with fund-score before/after (AGENTS rule 7).
 * ZTO TCOM move to their industry with scoring_mode pinned to 'chinese' (peer_group_overrides.scoring_mode,
 * Jamie's caveat: keep the China lens). COST already in Retail.
 * --only=ZTO,TCOM limits the run to those tickers (second pass, 10-18).
 * Usage: cd artifacts/api-server && pnpm exec tsx src/scripts/a148-peer-moves.ts [--apply]
 */
import { computeAndPersistFundamentalScores, type FundScoreResult } from "../lib/fundamentals-db.js";
import { setPeerGroupOverride } from "../lib/peer-classifier.js";
import { getLatestRegime } from "../routes/regime.js";
import { db, peerGroupOverrides } from "@workspace/db";
import { eq } from "drizzle-orm";

const MOVES: Record<string, string[]> = {
  "consumer_staples.packaged_goods_beverages": ["CPB", "CAG", "GIS", "HRL", "HSY", "KHC", "MDLZ", "SJM", "COTY"],
  "industrials.aerospace_defense": ["GE", "ATI"],
  "financials.banks": ["TFC", "PNC", "NU"], // A160: was regional_banks
  "technology.semiconductor_foundry_specialty": ["GFS"],
  "utilities.water_gas_multi_utilities": ["ATO"],
  "healthcare.speculative_biotech": ["CABA"],
  "consumer_discretionary.restaurants_food_service": ["SG", "REBN"],
  "technology.enterprise_software_cloud": ["BB", "SOUN", "SHOP"],
  "fintech.digital_finance_payments": ["BULL"],
  "financials.asset_management_alt_finance": ["STT", "BK"],
  "healthcare.large_pharma": ["GILD", "AMGN", "BIIB"],
  "industrials.transportation_logistics": ["ZTO"],
  "consumer_discretionary.travel_leisure_hospitality": ["TCOM"],
  // monthly review 10-18: business match (OpenJev ≥ 0.8) AND multiples closer to the new group (fwd P/E, P/S, GM, growth)
  "energy.clean_energy_renewables": ["PN"],
  "technology.semiconductors_design": ["CEVA", "KOPN"],
  "speculative_thematic.space_aerospace_tech": ["ONDS"],
  "consumer_discretionary.autos_evs": ["XPEV", "NIO", "LI"],
  // GICS (WRDS) + multiples both agree, 10-18
  "energy.integrated_oil_gas": ["CLNE"],
};
const MODE_PINS: Record<string, string> = { ZTO: "chinese", TCOM: "chinese", XPEV: "chinese", NIO: "chinese", LI: "chinese" };
const only = process.argv.find((a) => a.startsWith("--only="))?.slice(7).split(",");
const apply = process.argv.includes("--apply");
const regime = await getLatestRegime();
const byTicker = (rs: FundScoreResult[]) => new Map(rs.map((r) => [r.ticker, r]));

const before = byTicker(await computeAndPersistFundamentalScores(regime, "peer_override", { dryRun: true }));
if (apply) {
  for (const [group, tickers] of Object.entries(MOVES)) {
    for (const t of tickers) {
      if (only && !only.includes(t)) continue;
      await setPeerGroupOverride(t, group, "A148 OpenJev peer audit (Claude-reviewed), 2026-10-18");
      if (MODE_PINS[t]) await db.update(peerGroupOverrides).set({ scoringMode: MODE_PINS[t] }).where(eq(peerGroupOverrides.ticker, t));
    }
  }
}
const after = byTicker(await computeAndPersistFundamentalScores(regime, "peer_override", { dryRun: !apply }));

const f = (v: number | null | undefined) => (v == null ? "n/a" : v.toFixed(1));
const moved = new Set(Object.values(MOVES).flat().filter((t) => !only || only.includes(t)));
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
