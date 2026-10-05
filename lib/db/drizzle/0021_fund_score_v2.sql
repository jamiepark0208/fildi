ALTER TABLE "ticker_fundamentals" ADD COLUMN IF NOT EXISTS "gross_profit" numeric;
ALTER TABLE "ticker_fundamentals" ADD COLUMN IF NOT EXISTS "total_assets" numeric;
ALTER TABLE "ticker_fundamentals" ADD COLUMN IF NOT EXISTS "annual_operating_cash_flow" numeric;
ALTER TABLE "ticker_fundamentals" ADD COLUMN IF NOT EXISTS "fund_value_score" numeric;
ALTER TABLE "ticker_fundamentals" ADD COLUMN IF NOT EXISTS "style_bucket" text;
ALTER TABLE "ticker_fundamentals" ADD COLUMN IF NOT EXISTS "fund_score_confidence" text;

ALTER TABLE "ticker_fundamentals_history" ADD COLUMN IF NOT EXISTS "fcf" numeric;
ALTER TABLE "ticker_fundamentals_history" ADD COLUMN IF NOT EXISTS "roe" numeric;
ALTER TABLE "ticker_fundamentals_history" ADD COLUMN IF NOT EXISTS "debt_to_equity" numeric;
ALTER TABLE "ticker_fundamentals_history" ADD COLUMN IF NOT EXISTS "current_ratio" numeric;
ALTER TABLE "ticker_fundamentals_history" ADD COLUMN IF NOT EXISTS "total_assets" numeric;
ALTER TABLE "ticker_fundamentals_history" ADD COLUMN IF NOT EXISTS "gross_profit" numeric;
ALTER TABLE "ticker_fundamentals_history" ADD COLUMN IF NOT EXISTS "annual_ocf" numeric;
ALTER TABLE "ticker_fundamentals_history" ADD COLUMN IF NOT EXISTS "eps_growth" numeric;
ALTER TABLE "ticker_fundamentals_history" ADD COLUMN IF NOT EXISTS "revenue_growth" numeric;

ALTER TABLE "fmp_fundamentals" ADD COLUMN IF NOT EXISTS "fmp_total_assets" numeric;
ALTER TABLE "fmp_fundamentals" ADD COLUMN IF NOT EXISTS "fmp_gross_profit" numeric;
ALTER TABLE "fmp_fundamentals" ADD COLUMN IF NOT EXISTS "fmp_annual_operating_cash_flow" numeric;
