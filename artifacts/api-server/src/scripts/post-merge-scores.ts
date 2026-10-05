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
  const unscored = scores
    .filter((s) => s.totalScore == null)
    .map((s) => ({
      ticker: s.ticker,
      coverageTotal: s.coverage?.total ?? null,
      reason:
        (s.coverage?.total ?? 0) < 0.4
          ? "coverage_below_0.4"
          : !s.ranked
            ? "post_gate_unranked"
            : "null_total",
      peerGroupId: s.peerGroupId,
    }));
  // Durable observability: Maintain / Settings can treat rising unscored as an anomaly.
  console.log(
    JSON.stringify({
      ok: true,
      regime,
      scored: scores.length,
      scoredNonNull: scores.filter((s) => s.totalScore != null).length,
      unscoredCount: unscored.length,
      unscored: unscored.slice(0, 40),
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
