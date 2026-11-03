ALTER TABLE ticker_fundamentals
  ADD COLUMN IF NOT EXISTS negative_equity boolean NOT NULL DEFAULT false;
