-- Intraday session history + checkpoint grading (Live tab accountability).
--
-- Applied by hand rather than `drizzle-kit push`: the live DB carries a `session`
-- table owned by connect-pg-simple that isn't in the Drizzle schema, so push
-- opens an interactive prompt offering to drop it. Same reason app_config.sql and
-- stock_buckets.sql live here.
--
-- Idempotent — safe to re-run.

CREATE TABLE IF NOT EXISTS intraday_day_stats (
  id                 serial PRIMARY KEY,
  date               date NOT NULL,
  ticker             text NOT NULL,
  open               numeric NOT NULL,
  high               numeric NOT NULL,
  low                numeric NOT NULL,
  close              numeric NOT NULL,
  high_at_min        integer NOT NULL,
  low_at_min         integer NOT NULL,
  close_vs_open_pct  numeric NOT NULL,
  range_pct          numeric NOT NULL,
  day_shape          text NOT NULL,
  reversal_at_min    integer,
  bars_json          jsonb NOT NULL,
  created_at         timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT idx_intraday_day_stats_day UNIQUE (date, ticker)
);

CREATE INDEX IF NOT EXISTS idx_intraday_day_stats_shape
  ON intraday_day_stats (day_shape, date);

CREATE TABLE IF NOT EXISTS intraday_checkpoint_grades (
  id                   serial PRIMARY KEY,
  date                 date NOT NULL,
  ticker               text NOT NULL,
  min_after_open       integer NOT NULL,
  direction            text,
  confidence           integer,
  breakout             text NOT NULL,
  vwap_sep_pct         numeric NOT NULL,
  pullback_pct         numeric NOT NULL,
  prior_day_sweep      text,
  price_at_checkpoint  numeric NOT NULL,
  fwd_30m_pct          numeric,
  fwd_60m_pct          numeric,
  fwd_close_pct        numeric,
  grade                text NOT NULL DEFAULT 'pending',
  reconstructed        boolean NOT NULL DEFAULT false,
  graded_at            timestamptz,
  CONSTRAINT idx_intraday_cp_grades_checkpoint UNIQUE (date, ticker, min_after_open)
);

CREATE INDEX IF NOT EXISTS idx_intraday_cp_grades_bucket
  ON intraday_checkpoint_grades (min_after_open, direction, grade);

-- hotlist_snapshots: dual grading (strike safety alongside forward returns).
-- All additive and nullable except horizon_days, which defaults — existing rows
-- keep their PENDING/WIN/LOSS status and simply have no MAE until re-graded.
ALTER TABLE hotlist_snapshots ADD COLUMN IF NOT EXISTS entry_verdict   text;
ALTER TABLE hotlist_snapshots ADD COLUMN IF NOT EXISTS strike_ref      numeric;
ALTER TABLE hotlist_snapshots ADD COLUMN IF NOT EXISTS horizon_days    integer NOT NULL DEFAULT 14;
ALTER TABLE hotlist_snapshots ADD COLUMN IF NOT EXISTS mae_pct         numeric;
ALTER TABLE hotlist_snapshots ADD COLUMN IF NOT EXISTS strike_breached boolean;
ALTER TABLE hotlist_snapshots ADD COLUMN IF NOT EXISTS fwd_return_1d   numeric;
ALTER TABLE hotlist_snapshots ADD COLUMN IF NOT EXISTS fwd_return_10d  numeric;
