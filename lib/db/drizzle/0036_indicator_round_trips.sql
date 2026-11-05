-- Indicator grade = round trip (Jamie 11-04): entry at the signal-bar close, exit at the next opposite signal's close
-- (same indicator + tf, same session) else the session close; vs 50 seeded random entries, same side + hold length.
ALTER TABLE "indicator_grades" ADD COLUMN IF NOT EXISTS "rt_pct" numeric;
ALTER TABLE "indicator_grades" ADD COLUMN IF NOT EXISTS "rt_bars" integer;
ALTER TABLE "indicator_grades" ADD COLUMN IF NOT EXISTS "rt_exit" text;
ALTER TABLE "indicator_grades" ADD COLUMN IF NOT EXISTS "rt_random_pct" numeric;
ALTER TABLE "indicator_grades" ADD COLUMN IF NOT EXISTS "rt_random_win" numeric;
ALTER TABLE "indicator_scorecard" ADD COLUMN IF NOT EXISTS "win_pct" numeric;
ALTER TABLE "indicator_scorecard" ADD COLUMN IF NOT EXISTS "random_win_pct" numeric;
ALTER TABLE "indicator_scorecard" ADD COLUMN IF NOT EXISTS "avg_rt_pct" numeric;
ALTER TABLE "indicator_scorecard" ADD COLUMN IF NOT EXISTS "random_rt_pct" numeric;
ALTER TABLE "indicator_scorecard" ADD COLUMN IF NOT EXISTS "lift_pct" numeric;
ALTER TABLE "indicator_scorecard" ADD COLUMN IF NOT EXISTS "mde_pct" numeric;
