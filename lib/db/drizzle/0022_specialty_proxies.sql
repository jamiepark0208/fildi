-- Specialty free-API fills: P/TBV inputs + FFO proxy inputs
ALTER TABLE "ticker_fundamentals" ADD COLUMN IF NOT EXISTS "tangible_book_value_per_share" numeric;
ALTER TABLE "ticker_fundamentals" ADD COLUMN IF NOT EXISTS "depreciation_amortization" numeric;
ALTER TABLE "ticker_fundamentals" ADD COLUMN IF NOT EXISTS "ffo_proxy" numeric;

ALTER TABLE "finnhub_fundamentals" ADD COLUMN IF NOT EXISTS "finnhub_tangible_book_value_per_share" numeric;
ALTER TABLE "fmp_fundamentals" ADD COLUMN IF NOT EXISTS "fmp_tangible_book_value_per_share" numeric;
ALTER TABLE "edgar_fundamentals" ADD COLUMN IF NOT EXISTS "edgar_depreciation_amortization" numeric;
