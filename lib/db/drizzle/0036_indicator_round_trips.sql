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
-- Structure outcomes + calibrated confidence (Jamie 11-04: one up/down probability, many trade structures).
ALTER TABLE "indicator_grades" ADD COLUMN IF NOT EXISTS "abs_pct" numeric;
ALTER TABLE "indicator_grades" ADD COLUMN IF NOT EXISTS "random_abs_pct" numeric;
ALTER TABLE "indicator_grades" ADD COLUMN IF NOT EXISTS "no_breach" boolean;
ALTER TABLE "indicator_grades" ADD COLUMN IF NOT EXISTS "random_no_breach" numeric;
ALTER TABLE "indicator_grades" ADD COLUMN IF NOT EXISTS "target" boolean;
ALTER TABLE "indicator_grades" ADD COLUMN IF NOT EXISTS "random_target" numeric;
ALTER TABLE "indicator_scorecard" ADD COLUMN IF NOT EXISTS "p_win" numeric;
ALTER TABLE "indicator_scorecard" ADD COLUMN IF NOT EXISTS "p_win_lo" numeric;
ALTER TABLE "indicator_scorecard" ADD COLUMN IF NOT EXISTS "p_win_hi" numeric;
ALTER TABLE "indicator_scorecard" ADD COLUMN IF NOT EXISTS "structures" jsonb;
ALTER TABLE "indicator_scorecard" ADD COLUMN IF NOT EXISTS "best_structure" text;
-- Bracket (+1 ATR before -1 ATR) + vol-matched comparator flag (signals fire after moves; vol clusters).
ALTER TABLE "indicator_grades" ADD COLUMN IF NOT EXISTS "bracket" boolean;
ALTER TABLE "indicator_grades" ADD COLUMN IF NOT EXISTS "random_bracket" numeric;
ALTER TABLE "indicator_grades" ADD COLUMN IF NOT EXISTS "vol_matched" boolean;
