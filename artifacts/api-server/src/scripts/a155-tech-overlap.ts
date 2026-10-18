/**
 * A155 — top-20 overlap: old 8-comp weights vs new 6-comp champion (same component scores).
 * Usage: cd artifacts/api-server && pnpm exec tsx src/scripts/a155-tech-overlap.ts
 */
import { db, tickerTechnicals } from "@workspace/db";
import { computeTechnicalRankingsV2, type TechnicalRow } from "@workspace/option-scoring";

const OLD_W: Record<string, number> = {
  oversoldDepth: 0.20, reversalSignal: 0.17, volatilityState: 0.14, trendContext: 0.14,
  relativePressure: 0.08, optionsFlow: 0.08, analystUpside: 0.12, volumeConfirm: 0.07,
};

async function main() {
  const rows = (await db.select().from(tickerTechnicals)).map((r) => ({
    ...r,
    analystUpside: null,
    vsSpy20d: null,
    peerGroupId: null,
  })) as unknown as TechnicalRow[];

  const after = computeTechnicalRankingsV2(rows);
  const beforeScored = after.map((a) => {
    const comps = a.componentScores ?? {};
    let num = 0, den = 0;
    for (const [k, w] of Object.entries(OLD_W)) {
      const s = comps[k]?.score;
      if (s == null || !Number.isFinite(s)) continue;
      num += s * w;
      den += w;
    }
    return { ticker: a.ticker, total: den > 0 ? (num / den) * 100 : 0 };
  }).sort((x, y) => y.total - x.total);

  const top = (xs: { ticker: string }[], n = 20) => new Set(xs.slice(0, n).map((x) => x.ticker));
  const b20 = top(beforeScored);
  const a20 = top(after);
  let overlap = 0;
  for (const t of b20) if (a20.has(t)) overlap++;
  console.log(`A155 tech leaderboard top-20 overlap: ${overlap}/20`);
  console.log("before:", [...b20].join(" "));
  console.log("after: ", [...a20].join(" "));
  console.log("dropped:", [...b20].filter((t) => !a20.has(t)).join(" ") || "(none)");
  console.log("added:  ", [...a20].filter((t) => !b20.has(t)).join(" ") || "(none)");
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
