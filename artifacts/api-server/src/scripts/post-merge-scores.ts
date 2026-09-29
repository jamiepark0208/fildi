/**
 * After any maintain write path: re-merge gold + recompute fund_score.
 * Zero vendor API calls — DB-only.
 *
 *   pnpm exec tsx src/scripts/post-merge-scores.ts
 *   pnpm exec tsx src/scripts/post-merge-scores.ts --scores-only   # skip merge (caller already merged)
 */
import { runMergeTrusted } from "./merge-trusted.js";
import { computeAndPersistFundamentalScores } from "../lib/fundamentals-db.js";
import { getLatestRegime } from "../routes/regime.js";

const scoresOnly = process.argv.includes("--scores-only");

async function main() {
  if (!scoresOnly) {
    console.error("[post-merge-scores] merge-trusted…");
    await runMergeTrusted();
  } else {
    console.error("[post-merge-scores] --scores-only (skip merge)");
  }
  const regime = await getLatestRegime();
  console.error(`[post-merge-scores] fund_score recompute (regime=${regime ?? "null"})…`);
  const scores = await computeAndPersistFundamentalScores(regime);
  console.log(
    JSON.stringify({
      ok: true,
      regime,
      scored: scores.length,
      scoresOnly,
    }),
  );
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
