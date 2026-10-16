#!/usr/bin/env npx tsx
/**
 * Add prior_price_target + price_target_action on analyst_events (A97).
 *   cd artifacts/api-server && npx tsx src/scripts/migrate-0031-analyst-event-targets.ts
 */
import { sql } from "drizzle-orm";
import { db, pool } from "@workspace/db";

async function main() {
  await db.execute(sql`
    ALTER TABLE analyst_events
      ADD COLUMN IF NOT EXISTS prior_price_target numeric,
      ADD COLUMN IF NOT EXISTS price_target_action text
  `);
  console.log("migration 0031_analyst_event_targets applied");
  await pool.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
