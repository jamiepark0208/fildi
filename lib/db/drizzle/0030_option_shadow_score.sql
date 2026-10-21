-- A172: store parent-champion (shadow) option score beside live champion picks.
ALTER TABLE "option_score_snapshots" ADD COLUMN IF NOT EXISTS "shadow_score" numeric;
ALTER TABLE "option_score_snapshots" ADD COLUMN IF NOT EXISTS "shadow_version" text;
ALTER TABLE "model_recs" ADD COLUMN IF NOT EXISTS "shadow_score" numeric;
ALTER TABLE "model_recs" ADD COLUMN IF NOT EXISTS "shadow_version" text;
