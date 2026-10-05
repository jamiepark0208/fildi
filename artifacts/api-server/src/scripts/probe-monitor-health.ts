/**
 * One-shot probe: research-ops lastError + enrichment freshness + unscored active.
 *   pnpm exec tsx --env-file=../../.env.local src/scripts/probe-monitor-health.ts
 */
import { getResearchOpsReport } from "../lib/research-ops.js";
import { pool } from "@workspace/db";

async function main() {
  const r = await getResearchOpsReport();
  const e = await pool.query<{ finished_at: Date; trigger: string; status: string }>(
    `SELECT finished_at, trigger, status FROM enrichment_runs
     WHERE status IN ('success','partial') ORDER BY finished_at DESC LIMIT 1`,
  );
  const a = await pool.query<{ n: number }>(
    `SELECT COUNT(*)::int AS n
     FROM ticker_fundamentals tf
     JOIN ticker_registry reg ON reg.ticker = tf.ticker
     WHERE reg.fetch_fundamentals
       AND tf.fund_total_score IS NULL
       AND UPPER(tf.ticker) NOT IN (
         'SMH','SOXX','IWM','QQQ','SPY','ARKG','CANE','BIZD','JBBB',
         'NVDY','SPCK','PSUS','HOOY','DRAM','ARKQ','XOP','GOOY','RVI'
       )`,
  );
  console.log(
    JSON.stringify(
      {
        wrdsLastError: r.wrds.lastError,
        lsegLastError: r.lseg.lastError,
        fixHints: r.fixHints.slice(0, 4),
        wrdsOverall: r.wrds.overall,
        lsegOverall: r.lseg.overall,
        lastEnrichment: e.rows[0] ?? null,
        unscoredActive: a.rows[0]?.n ?? null,
      },
      null,
      2,
    ),
  );
  await pool.end();
}

main().catch(async (err) => {
  console.error(err);
  try {
    await pool.end();
  } catch {
    /* ignore */
  }
  process.exit(1);
});
