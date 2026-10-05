#!/usr/bin/env npx tsx
/**
 * Apply hotlist_snapshots column alignment (migration 0027).
 *   cd artifacts/api-server && npx tsx src/scripts/migrate-0027-hotlist-snapshot-columns.ts
 */
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";

async function main() {
  await db.execute(sql`ALTER TABLE "hotlist_snapshots" ADD COLUMN IF NOT EXISTS "entry_verdict" text`);
  await db.execute(sql`ALTER TABLE "hotlist_snapshots" ADD COLUMN IF NOT EXISTS "strike_ref" numeric`);
  await db.execute(sql`ALTER TABLE "hotlist_snapshots" ADD COLUMN IF NOT EXISTS "horizon_days" integer NOT NULL DEFAULT 14`);
  await db.execute(sql`ALTER TABLE "hotlist_snapshots" ADD COLUMN IF NOT EXISTS "mae_pct" numeric`);
  await db.execute(sql`ALTER TABLE "hotlist_snapshots" ADD COLUMN IF NOT EXISTS "strike_breached" boolean`);
  await db.execute(sql`ALTER TABLE "hotlist_snapshots" ADD COLUMN IF NOT EXISTS "fwd_return_1d" numeric`);
  await db.execute(sql`ALTER TABLE "hotlist_snapshots" ADD COLUMN IF NOT EXISTS "fwd_return_10d" numeric`);
  console.log("migration 0027_hotlist_snapshot_columns applied");
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
