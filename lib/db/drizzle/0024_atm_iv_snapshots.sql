ALTER TABLE "ticker_technicals" ADD COLUMN IF NOT EXISTS "iv_rank_source" text;
CREATE TABLE IF NOT EXISTS "ticker_atm_iv_snapshots" (
  "ticker" text NOT NULL,
  "as_of" date NOT NULL,
  "atm_put_iv" numeric NOT NULL,
  "iv_vs_realized" numeric,
  PRIMARY KEY ("ticker", "as_of")
);
CREATE INDEX IF NOT EXISTS "idx_atm_iv_snapshots_ticker" ON "ticker_atm_iv_snapshots" ("ticker");
