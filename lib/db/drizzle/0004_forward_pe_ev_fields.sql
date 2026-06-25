ALTER TABLE "ticker_fundamentals"
  ADD COLUMN IF NOT EXISTS "forward_pe"                  numeric,
  ADD COLUMN IF NOT EXISTS "ev_ebitda"                   numeric,
  ADD COLUMN IF NOT EXISTS "ev_revenue"                  numeric,
  ADD COLUMN IF NOT EXISTS "revenue_growth_yoy_prior"    numeric,
  ADD COLUMN IF NOT EXISTS "regime_at_score"             text;
