-- Align hotlist_snapshots with Drizzle schema (model snapshot was failing:
-- column "entry_verdict" of relation "hotlist_snapshots" does not exist).
ALTER TABLE "hotlist_snapshots" ADD COLUMN IF NOT EXISTS "entry_verdict" text;
ALTER TABLE "hotlist_snapshots" ADD COLUMN IF NOT EXISTS "strike_ref" numeric;
ALTER TABLE "hotlist_snapshots" ADD COLUMN IF NOT EXISTS "horizon_days" integer NOT NULL DEFAULT 14;
ALTER TABLE "hotlist_snapshots" ADD COLUMN IF NOT EXISTS "mae_pct" numeric;
ALTER TABLE "hotlist_snapshots" ADD COLUMN IF NOT EXISTS "strike_breached" boolean;
ALTER TABLE "hotlist_snapshots" ADD COLUMN IF NOT EXISTS "fwd_return_1d" numeric;
ALTER TABLE "hotlist_snapshots" ADD COLUMN IF NOT EXISTS "fwd_return_10d" numeric;
