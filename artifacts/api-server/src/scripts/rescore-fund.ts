/**
 * Recompute + persist fund scores now (trigger admin_recompute) and print what moved vs the stored scores.
 * Use after a scoring-code change instead of waiting for the nightly run.
 * Usage: cd artifacts/api-server && pnpm exec tsx src/scripts/rescore-fund.ts [--dry] [--top 30]
 */
import { db, tickerFundamentals } from "@workspace/db";
import { computeAndPersistFundamentalScores } from "../lib/fundamentals-db.js";
import { getLatestRegime } from "../routes/regime.js";

const dry = process.argv.includes("--dry");
const topArg = process.argv.indexOf("--top");
const top = topArg > 0 ? Number(process.argv[topArg + 1]) : 30;

const before = new Map(
  (await db.select({ t: tickerFundamentals.ticker, s: tickerFundamentals.fundTotalScore, r: tickerFundamentals.fundRank, b: tickerFundamentals.styleBucket })
    .from(tickerFundamentals)).map((x) => [x.t, x]),
);
const after = await computeAndPersistFundamentalScores(await getLatestRegime(), "admin_recompute", { dryRun: dry });
const moves = after
  .map((a) => {
    const b = before.get(a.ticker);
    return { t: a.ticker, s0: b?.s == null ? null : Number(b.s), s1: a.totalScore, r0: b?.r ?? null, r1: a.rank, b0: b?.b ?? null, b1: a.styleBucket ?? null };
  })
  .filter((m) => m.s0 != null && m.s1 != null);
const d = moves.map((m) => Math.abs(m.s1! - m.s0!)).sort((x, y) => x - y);
console.log(`${dry ? "dry run" : "persisted"} · ${after.length} scored · |Δscore| median ${d[d.length >> 1]?.toFixed(2)} · >5 pts ${d.filter((x) => x > 5).length} · style changed ${moves.filter((m) => m.b0 !== m.b1).length}`);
for (const m of moves.sort((x, y) => Math.abs(y.s1! - y.s0!) - Math.abs(x.s1! - x.s0!)).slice(0, top)) {
  console.log(`${m.t.padEnd(6)} ${m.s0!.toFixed(1)} → ${m.s1!.toFixed(1)}  rank ${m.r0} → ${m.r1}  ${m.b0 === m.b1 ? m.b1 : `${m.b0} → ${m.b1}`}`);
}
process.exit(0);
