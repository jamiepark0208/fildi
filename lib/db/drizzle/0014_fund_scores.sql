ALTER TABLE "ticker_fundamentals" ADD COLUMN "fund_total_score" numeric;
ALTER TABLE "ticker_fundamentals" ADD COLUMN "fund_quality_score" numeric;
ALTER TABLE "ticker_fundamentals" ADD COLUMN "fund_growth_score" numeric;
ALTER TABLE "ticker_fundamentals" ADD COLUMN "fund_safety_score" numeric;
ALTER TABLE "ticker_fundamentals" ADD COLUMN "fund_rank" integer;
ALTER TABLE "ticker_fundamentals" ADD COLUMN "fund_score_computed_at" timestamp with time zone;
