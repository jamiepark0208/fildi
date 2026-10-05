/**
 * Ensure scorecard learning tables/columns (A18): scorecard_params seeds,
 * tech_score_snapshots, A14 columns on fund/option snapshots.
 *
 *   pnpm exec tsx src/scripts/ensure-scorecard-learning.ts
 */
import { ensureScorecardParamsTables, getChampionScorecardParams } from "../lib/scorecard-params.js";
import { ensureTechScoreSnapshotTables, persistTechScoreSnapshots } from "../lib/tech-score-snapshots.js";
import { ensureFundScoreAccountabilityTables } from "../lib/fund-score-snapshots.js";
import { pool } from "@workspace/db";

async function main() {
  await ensureScorecardParamsTables();
  await ensureFundScoreAccountabilityTables();
  await ensureTechScoreSnapshotTables();
  await pool.query(`
    ALTER TABLE option_score_snapshots ADD COLUMN IF NOT EXISTS coverage numeric;
    ALTER TABLE option_score_snapshots ADD COLUMN IF NOT EXISTS confidence text;
    ALTER TABLE option_score_snapshots ADD COLUMN IF NOT EXISTS model_version text;
    ALTER TABLE option_score_snapshots ADD COLUMN IF NOT EXISTS inputs_digest text;
  `);

  const champs = {
    fund: await getChampionScorecardParams("fund"),
    tech: await getChampionScorecardParams("tech"),
    options: await getChampionScorecardParams("options"),
  };

  const tech = await persistTechScoreSnapshots({ trigger: "ensure_scorecard_learning" });

  console.log(
    JSON.stringify(
      {
        ok: true,
        champions: Object.fromEntries(
          Object.entries(champs).map(([k, v]) => [k, v.version]),
        ),
        techSnapshots: tech,
      },
      null,
      2,
    ),
  );
  await pool.end();
}

main().catch(async (e) => {
  console.error(e);
  try {
    await pool.end();
  } catch {
    /* ignore */
  }
  process.exit(1);
});
