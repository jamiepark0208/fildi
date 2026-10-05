-- Persist nightly best-strike option scores for Overall rankings (not watchlist-only).
CREATE TABLE IF NOT EXISTS "option_score_snapshots" (
  "ticker" text NOT NULL,
  "side" text NOT NULL,
  "as_of" date NOT NULL,
  "strike" numeric NOT NULL,
  "expiry" date NOT NULL,
  "spot" numeric NOT NULL,
  "premium" numeric NOT NULL,
  "weekly_income_pct" numeric,
  "otm_pct" numeric,
  "delta" numeric,
  "strike_iv" numeric,
  "dte" numeric,
  "option_score" numeric NOT NULL,
  "component_scores" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "earnings_days_out" integer,
  "earnings_risk" boolean NOT NULL DEFAULT false,
  "bid_is_live" boolean NOT NULL DEFAULT true,
  "quote_stale" boolean NOT NULL DEFAULT false,
  "data_quality" numeric,
  "atm_put_iv" numeric,
  "iv_vs_realized" numeric,
  "computed_at" timestamp with time zone NOT NULL DEFAULT now(),
  PRIMARY KEY ("ticker", "side", "as_of")
);
CREATE INDEX IF NOT EXISTS "idx_option_score_snapshots_as_of" ON "option_score_snapshots" ("as_of");
CREATE INDEX IF NOT EXISTS "idx_option_score_snapshots_side_score" ON "option_score_snapshots" ("side", "as_of", "option_score");
