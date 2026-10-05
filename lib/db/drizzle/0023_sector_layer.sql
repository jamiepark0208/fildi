ALTER TABLE "ticker_fundamentals" ADD COLUMN IF NOT EXISTS "fund_company_score" numeric;
ALTER TABLE "ticker_fundamentals" ADD COLUMN IF NOT EXISTS "fund_sector_score" numeric;
