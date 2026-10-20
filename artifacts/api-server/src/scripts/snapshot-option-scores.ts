#!/usr/bin/env npx tsx
/**
 * Overall options rankings snapshot — run by the Model List each morning (daily.py) with live quotes.
 *   cd artifacts/api-server && npx tsx src/scripts/snapshot-option-scores.ts
 *   npx tsx src/scripts/snapshot-option-scores.ts --dry-run --limit=20
 */
import { computeAndPersistOptionScores } from "../lib/option-score-snapshots.js";
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";

async function ensureTable() {
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS "option_score_snapshots" (
      "ticker" text NOT NULL,
      "side" text NOT NULL,
      "as_of" date NOT NULL,
      "strike" numeric NOT NULL,
      "expiry" date NOT NULL,
      "spot" numeric NOT NULL,
      "premium" numeric NOT NULL,
      "weekly_income_pct" numeric,
      "otm_pct" numeric,
      "delta" numeric,
      "strike_iv" numeric,
      "dte" numeric,
      "option_score" numeric NOT NULL,
      "component_scores" jsonb NOT NULL DEFAULT '{}'::jsonb,
      "earnings_days_out" integer,
      "earnings_risk" boolean NOT NULL DEFAULT false,
      "bid_is_live" boolean NOT NULL DEFAULT true,
      "quote_stale" boolean NOT NULL DEFAULT false,
      "data_quality" numeric,
      "atm_put_iv" numeric,
      "iv_vs_realized" numeric,
      "computed_at" timestamp with time zone NOT NULL DEFAULT now(),
      PRIMARY KEY ("ticker", "side", "as_of")
    )
  `);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS "idx_option_score_snapshots_as_of" ON "option_score_snapshots" ("as_of")`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS "idx_option_score_snapshots_side_score" ON "option_score_snapshots" ("side", "as_of", "option_score")`);
}

async function main() {
  const dryRun = process.argv.includes("--dry-run");
  const limitArg = process.argv.find((a) => a.startsWith("--limit="));
  const limit = limitArg ? parseInt(limitArg.split("=")[1]!, 10) : undefined;

  if (!dryRun) await ensureTable();

  const result = await computeAndPersistOptionScores({ dryRun, limit });
  console.log(JSON.stringify(result, null, 2));
  // Morning run from the Model List (daily.py, 10-20) counts as the day's scan → the scheduler's noon run becomes a fallback.
  if (!dryRun && !limit) {
    const at = JSON.stringify(new Date().toISOString());
    await db.execute(sql`INSERT INTO app_config (key, value) VALUES ('last_option_score_snapshot_run', ${at}::jsonb)
      ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`);
  }
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
