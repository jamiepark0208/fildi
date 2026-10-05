#!/usr/bin/env npx tsx
/**
 * Dump strongest/weakest metric contributions for selected tickers.
 *   cd artifacts/api-server && npx tsx src/scripts/analyze-fund-factors.ts
 */
import { computeAndPersistFundamentalScores } from "../lib/fundamentals-db.js";
import { db, marketRegime } from "@workspace/db";
import { desc } from "drizzle-orm";

const FOCUS = ["PLTR", "ALNY", "FUTU", "MU", "LLY", "NVDA", "GOOGL", "AAPL", "MSFT", "IONQ", "T", "ACN"];

async function main() {
  const rows = await db.select({ regime: marketRegime.regime }).from(marketRegime).orderBy(desc(marketRegime.computedAt)).limit(1);
  const regime = rows[0]?.regime ?? null;
  // Recompute in-memory only? computeAndPersist writes — OK we need fresh metricScores from return value
  const results = await computeAndPersistFundamentalScores(regime);
  const byT = new Map(results.map((r) => [r.ticker, r]));

  const ranked = results.filter((r) => r.ranked && r.totalScore != null).sort((a, b) => b.totalScore! - a.totalScore!);

  console.log("=== TOP 10 AFTER CURRENT ENGINE ===");
  console.log(ranked.slice(0, 10).map((r, i) => `${i + 1}. ${r.ticker} ${r.totalScore} ${r.styleBucket} V${r.valueScore} Q${r.qualityScore} G${r.growthScore} S${r.safetyScore}`).join("\n"));

  // Aggregate: for each metric, mean |weightedScore| among top-20 and among all ranked
  const top20 = ranked.slice(0, 20);
  const metricSum: Record<string, { sum: number; n: number; pos: number; neg: number }> = {};
  for (const r of top20) {
    for (const [k, v] of Object.entries(r.metricScores ?? {})) {
      if (!metricSum[k]) metricSum[k] = { sum: 0, n: 0, pos: 0, neg: 0 };
      const w = v.weightedScore ?? 0;
      if (w === 0 && (v.value == null)) continue;
      metricSum[k].sum += w;
      metricSum[k].n++;
      if (w > 0.5) metricSum[k].pos++;
      if (w < 0.15 && w > 0) metricSum[k].neg++; // small positive contrib
    }
  }
  const agg = Object.entries(metricSum)
    .map(([k, v]) => ({ k, avg: v.n ? v.sum / v.n : 0, n: v.n, highHits: v.pos }))
    .sort((a, b) => b.avg - a.avg);

  console.log("\n=== TOP-20 MEAN WEIGHTED METRIC CONTRIB (prime factors of board) ===");
  for (const a of agg.slice(0, 12)) console.log(`  ${a.k.padEnd(16)} avgW=${a.avg.toFixed(3)} n=${a.n} highHits=${a.highHits}`);
  console.log("--- weakest avg contrib ---");
  for (const a of agg.slice(-8).reverse()) console.log(`  ${a.k.padEnd(16)} avgW=${a.avg.toFixed(3)} n=${a.n}`);

  console.log("\n=== PER-TICKER STRONGEST / WEAKEST ===");
  for (const t of FOCUS) {
    const r = byT.get(t);
    if (!r || !r.metricScores) {
      console.log(`${t}: missing`);
      continue;
    }
    const entries = Object.entries(r.metricScores)
      .map(([k, v]) => ({ k, w: v.weightedScore ?? 0, val: v.value }))
      .filter((e) => e.w !== 0 || e.val != null)
      .sort((a, b) => b.w - a.w);
    const strong = entries.slice(0, 5);
    const weak = [...entries].filter((e) => e.w > 0).slice(-5).reverse();
    const zeroish = entries.filter((e) => e.w === 0 && e.val != null).slice(0, 3);
    console.log(
      `\n${t} rank=${ranked.findIndex((x) => x.ticker === t) + 1} total=${r.totalScore} style=${r.styleBucket} ` +
        `V=${r.valueScore} Q=${r.qualityScore} G=${r.growthScore} S=${r.safetyScore}`,
    );
    console.log("  STRONG:", strong.map((e) => `${e.k}=${e.w.toFixed(2)}(raw=${e.val == null ? "n" : Number(e.val).toFixed(3)})`).join(" | "));
    console.log("  WEAK:  ", weak.map((e) => `${e.k}=${e.w.toFixed(2)}(raw=${e.val == null ? "n" : Number(e.val).toFixed(3)})`).join(" | "));
    if (zeroish.length) console.log("  ZERO:  ", zeroish.map((e) => `${e.k}(raw=${Number(e.val).toFixed(3)})`).join(" | "));
  }
}

main().then(() => process.exit(0)).catch((e) => {
  console.error(e);
  process.exit(1);
});
