-- Research-only LSEG Workspace staging. Academic / non-commercial.
-- NEVER merge into ticker_fundamentals / fund_score via FIELD_DEFS.
-- Lane contract: research/LSEG_WRDS_SYNC.md (Claude Code owns this file).
-- Apply: research/lseg/.venv/bin/python -c "from db import ensure_schema; ensure_schema()"

CREATE SCHEMA IF NOT EXISTS lseg_research;

-- Same shape as wrds_research.sync_state / pull_log so one health check covers both lanes.
CREATE TABLE IF NOT EXISTS lseg_research.sync_state (
  dataset       text PRIMARY KEY,
  watermark     text,
  last_ok_at    timestamptz,
  last_rows     integer,
  last_tickers  text[],
  notes         text
);

CREATE TABLE IF NOT EXISTS lseg_research.pull_log (
  id            bigserial PRIMARY KEY,
  dataset       text NOT NULL,
  started_at    timestamptz NOT NULL DEFAULT now(),
  finished_at   timestamptz,
  status        text NOT NULL,
  tickers       text[],
  rows_upserted integer,
  watermark_from text,
  watermark_to   text,
  error         text
);

-- One row per ticker per pull date: current consensus, StarMine, short interest, credit.
CREATE TABLE IF NOT EXISTS lseg_research.signals_daily (
  ticker                 text NOT NULL,
  as_of                  date NOT NULL,
  ric                    text NOT NULL,
  price_close            double precision,
  -- consensus (I/B/E/S current snapshot; history is WRDS-owned)
  eps_mean_fy1           double precision,
  eps_mean_fy1_30d_ago   double precision,
  eps_drift_30d_pct      double precision,   -- (now - 30d ago) / |30d ago| * 100
  eps_num_est_fy1        integer,
  fy1_period             text,               -- e.g. FY2027 (loop A match key)
  fy1_period_end         date,               -- matches ibes_statsum.fpedats
  revenue_mean_fy1       double precision,
  rec_mean               double precision,   -- 1=strong buy … 5=sell
  pt_mean                double precision,
  pt_upside_pct          double precision,
  -- StarMine
  eps_smart_fy1          double precision,
  smart_vs_cons_pct      double precision,   -- (SmartEstimate - mean) / |mean| * 100
  pred_surprise_pct_fq1  double precision,
  fq1_period_end         date,
  arm_rank               integer,            -- 1..100 region rank
  combined_alpha_rank    integer,
  valmo_rank             integer,
  -- crowding / credit
  short_interest         double precision,
  short_pct              double precision,
  free_float             double precision,
  shares_out             double precision,
  issuer_rating          text,
  cds_ric                text,
  fetched_at             timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (ticker, as_of)
);

CREATE INDEX IF NOT EXISTS idx_lseg_signals_asof ON lseg_research.signals_daily (as_of DESC);

-- Forward corporate events (earnings, analyst meetings, …).
CREATE TABLE IF NOT EXISTS lseg_research.events (
  ticker        text NOT NULL,
  ric           text NOT NULL,
  event_date    date NOT NULL,
  event_type    text NOT NULL,
  title         text,
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  fetched_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (ticker, event_date, event_type)
);

CREATE INDEX IF NOT EXISTS idx_lseg_events_date ON lseg_research.events (event_date);

-- Monthly StarMine history for loop B calibration (Predicted Surprise, Combined Alpha).
-- ARM has no history via the API — current value only, in signals_daily.
CREATE TABLE IF NOT EXISTS lseg_research.starmine_history (
  ticker        text NOT NULL,
  ric           text NOT NULL,
  metric        text NOT NULL,   -- pred_surprise_pct_fq1 | combined_alpha_rank
  obs_date      date NOT NULL,
  value         double precision,
  fetched_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (ticker, metric, obs_date)
);

-- Coverage universe built from the user's own behaviour (coverage.py): held / traded / watchlist /
-- lookalike / book. Default universe for every LSEG sync.
CREATE TABLE IF NOT EXISTS lseg_research.coverage (
  ticker       text PRIMARY KEY,
  tier         integer NOT NULL,   -- 1 held · 2 traded · 3 watchlist · 4 lookalike · 5 book
  label        text NOT NULL,
  score        double precision,
  reason       text,
  computed_at  timestamptz NOT NULL DEFAULT now()
);

-- 2026-10-04: credit risk + extra StarMine models + estimate dispersion (radar filter, earnings-premium check).
ALTER TABLE lseg_research.signals_daily ADD COLUMN IF NOT EXISTS credit_combined_rank integer;   -- 1..100, low = higher distress risk
ALTER TABLE lseg_research.signals_daily ADD COLUMN IF NOT EXISTS price_mo_rank integer;
ALTER TABLE lseg_research.signals_daily ADD COLUMN IF NOT EXISTS relval_rank integer;
ALTER TABLE lseg_research.signals_daily ADD COLUMN IF NOT EXISTS price_to_intrinsic double precision;
ALTER TABLE lseg_research.signals_daily ADD COLUMN IF NOT EXISTS eps_mean_fq1 double precision;
ALTER TABLE lseg_research.signals_daily ADD COLUMN IF NOT EXISTS eps_std_fq1 double precision;
ALTER TABLE lseg_research.signals_daily ADD COLUMN IF NOT EXISTS eps_high_fq1 double precision;
ALTER TABLE lseg_research.signals_daily ADD COLUMN IF NOT EXISTS eps_low_fq1 double precision;
ALTER TABLE lseg_research.signals_daily ADD COLUMN IF NOT EXISTS eps_num_est_fq1 integer;
ALTER TABLE lseg_research.signals_daily ADD COLUMN IF NOT EXISTS rev_pred_surprise_pct_fq1 double precision;

-- Realized 2-day stock move around each past earnings report (close before → close after the report date;
-- covers both pre-market and after-close reports). Feeds the "is earnings premium over/underpriced" check.
CREATE TABLE IF NOT EXISTS lseg_research.earnings_moves (
  ticker        text NOT NULL,
  report_date   date NOT NULL,
  move_pct      double precision NOT NULL,   -- signed %, close(next day) / close(prev day) - 1
  price_source  text NOT NULL,               -- app (prices_historical) | lseg
  computed_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (ticker, report_date)
);

-- Top-10 holders per ticker (latest filings). Current ownership is LSEG-owned; 13F *history* is WRDS (§2).
CREATE TABLE IF NOT EXISTS lseg_research.holders_top (
  ticker         text NOT NULL,
  as_of          date NOT NULL,
  rank           integer NOT NULL,
  investor       text NOT NULL,
  investor_type  text,
  pct_out        double precision,    -- % of traded shares held
  change_shares  double precision,    -- change vs that holder's previous filing
  filing_date    date,
  PRIMARY KEY (ticker, as_of, rank)
);

-- LSEG as auditor of the gold layer: never writes ticker_fundamentals, only records disagreements for review.
CREATE TABLE IF NOT EXISTS lseg_research.gold_audit (
  ticker       text NOT NULL,
  field        text NOT NULL,            -- analyst_target_price | shares_outstanding | next_earnings_date
  gold_value   text,
  gold_source  text,                     -- field_provenance.winning_source / 'earnings_calendar'
  lseg_value   text,
  diff         double precision,         -- % for numbers, days for dates
  severity     text NOT NULL,            -- warn | high
  checked_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (ticker, field)
);

-- 2026-10-04: LSEG implied vol (IMP_VOLT, decimal) — independent cross-check for Fildi's Yahoo nearest-expiry atm_put_iv,
-- which ran 1.45–3.4× higher on 7/8 "rich premium" names.
ALTER TABLE lseg_research.signals_daily ADD COLUMN IF NOT EXISTS imp_volt double precision;

-- Research-only daily history for backtests (watchlist-sync Step 3). NOT merged into the app's prices_historical.
-- close: LSEG TRDPRC_1 on the security_map RIC. iv*: <TICKER>ATMIV.U at-the-money implied vol (percent), 30/60/90d, put/call.
CREATE TABLE IF NOT EXISTS lseg_research.daily_history (
  ticker      text NOT NULL,
  date        date NOT NULL,
  close       real,               -- 4-byte floats: ~7 significant digits, ample for prices + IV (2026-10-05)
  iv30_put    real,
  iv30_call   real,
  iv60_put    real,
  iv60_call   real,
  iv90_put    real,
  iv90_call   real,
  fetched_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (ticker, date)
);
ALTER TABLE lseg_research.signals_daily ADD COLUMN IF NOT EXISTS pt_median double precision;   -- A283 street range (10-29)
ALTER TABLE lseg_research.signals_daily ADD COLUMN IF NOT EXISTS pt_high double precision;
ALTER TABLE lseg_research.signals_daily ADD COLUMN IF NOT EXISTS pt_low double precision;
ALTER TABLE lseg_research.signals_daily ADD COLUMN IF NOT EXISTS pt_num_est integer;
-- 11-09 (Claude, A244/S100): WRDS IBES stops at 2026-08-20 → revision features from LSEG (same I/B/E/S consensus, daily).
-- Checked vs IBES on 08-20 (120 names): level median gap 0.13 %, 1m drift corr 0.79 (sign 95 %), breadth corr 0.93.
ALTER TABLE lseg_research.signals_daily ADD COLUMN IF NOT EXISTS eps_mean_fy1_90d_ago double precision;
ALTER TABLE lseg_research.signals_daily ADD COLUMN IF NOT EXISTS eps_mean_fy2 double precision;
ALTER TABLE lseg_research.signals_daily ADD COLUMN IF NOT EXISTS eps_std_fy1 double precision;
ALTER TABLE lseg_research.signals_daily ADD COLUMN IF NOT EXISTS eps_num_up_fy1 integer;     -- brokers whose FY1 estimate rose vs 30 days ago
ALTER TABLE lseg_research.signals_daily ADD COLUMN IF NOT EXISTS eps_num_down_fy1 integer;   -- … fell
ALTER TABLE lseg_research.signals_daily ADD COLUMN IF NOT EXISTS eps_num_brokers_fy1 integer; -- brokers with a current FY1 detail estimate
