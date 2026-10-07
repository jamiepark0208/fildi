// Fixture rows land in the live model_recs / hotlist_snapshots tables (macroRegime='fixture').
// Tilt + grading read those same tables with no fixture filter — never run against prod.
// Guard MUST run before any @workspace/db import (static imports would connect first).
const nodeEnv = process.env.NODE_ENV;
if (nodeEnv !== "development" && nodeEnv !== "test") {
  throw new Error(
    `verify-track-record: refusing to seed fixture model_recs ` +
      `(NODE_ENV=${nodeEnv ?? "unset"}). Require NODE_ENV=development or NODE_ENV=test. ` +
      `Running this against production corrupts the model self-correction loop.`,
  );
}

const { db, modelRecs, hotlistSnapshots, pricesHistorical } = await import("@workspace/db");
const { and, eq, desc, sql } = await import("drizzle-orm");
const { runModelGrading, insertRegimeGradeStubs } = await import("./src/lib/model-track-record.ts");

const candidates = await db.execute(sql`
  SELECT ticker, COUNT(*)::int AS bars FROM prices_historical
  WHERE date > (CURRENT_DATE - INTERVAL '30 days')
  GROUP BY ticker HAVING COUNT(*) >= 6
  ORDER BY ticker LIMIT 4
`);
const tickers = candidates.rows.map(r => r.ticker);
console.log("candidate tickers:", tickers);
if (tickers.length === 0) { console.log("NO CANDIDATES - abort"); process.exit(0); }

const snapshotDate = new Date(Date.now() - 21 * 86_400_000).toISOString().slice(0, 10);
const expiry = new Date(Date.now() - 7 * 86_400_000).toISOString().slice(0, 10);
let recs = 0, hotlist = 0;
for (const ticker of tickers) {
  const [bar] = await db.select({ close: pricesHistorical.close }).from(pricesHistorical)
    .where(and(eq(pricesHistorical.ticker, ticker), sql`${pricesHistorical.date} <= ${snapshotDate}`))
    .orderBy(desc(pricesHistorical.date)).limit(1);
  const spot = bar?.close != null ? Number(bar.close) : null;
  if (spot == null || spot <= 0) continue;
  for (const side of ["put", "call"]) {
    const strike = side === "put" ? spot * 0.93 : spot * 1.07;
    const inserted = await db.insert(modelRecs).values({
      snapshotDate, ticker, side, expiry,
      strike: String(Math.round(strike * 100) / 100),
      spot: String(spot),
      premium: String(Math.round(spot * 0.01 * 100) / 100),
      bidIsLive: false, optionScore: "50",
      componentScores: { fixture: { score: null, weight: 0 } },
      volRegime: "BASELINE", macroRegime: "fixture",
      tiltApplied: { factor: 0, weights: {} },
    }).onConflictDoNothing({ target: [modelRecs.snapshotDate, modelRecs.ticker, modelRecs.side] })
      .returning({ id: modelRecs.id });
    recs += inserted.length;
  }
  const insertedHot = await db.insert(hotlistSnapshots).values({
    snapshotDate, ticker, side: "dip", signal: "GO", price: String(spot), rsi: "25", mfi: "18",
  }).onConflictDoNothing({ target: [hotlistSnapshots.snapshotDate, hotlistSnapshots.ticker, hotlistSnapshots.side] })
    .returning({ id: hotlistSnapshots.id });
  hotlist += insertedHot.length;
}
const regimeStubs = await insertRegimeGradeStubs();
console.log("seeded:", { recs, hotlist, regimeStubs });

await runModelGrading();
console.log("grading complete");

const graded = await db.select({ ticker: modelRecs.ticker, side: modelRecs.side, status: modelRecs.status, pnlPct: modelRecs.pnlPct })
  .from(modelRecs).where(eq(modelRecs.macroRegime, "fixture"));
console.log("graded fixture recs:", graded);
process.exit(0);
