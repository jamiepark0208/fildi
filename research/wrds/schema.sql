-- Research-only WRDS staging. Academic / non-commercial.
-- NEVER merge into ticker_fundamentals / fund_score via FIELD_DEFS.
-- Apply: python -c "from db import ensure_schema; ensure_schema()"  OR
--        psql "$DATABASE_URL" -f research/wrds/schema.sql

CREATE SCHEMA IF NOT EXISTS wrds_research;

CREATE TABLE IF NOT EXISTS wrds_research.sync_state (
  dataset       text PRIMARY KEY,
  watermark     text,
  last_ok_at    timestamptz,
  last_rows     integer,
  last_tickers  text[],
  notes         text
);

CREATE TABLE IF NOT EXISTS wrds_research.pull_log (
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

CREATE TABLE IF NOT EXISTS wrds_research.ibes_statsum (
  source_key    text PRIMARY KEY,
  oftic         text NOT NULL,
  ticker        text,
  measure       text NOT NULL DEFAULT 'EPS',
  fiscalp       text,
  fpi           text,
  statpers      date NOT NULL,
  fpedats       date,
  numest        integer,
  numup         integer,
  numdown       integer,
  medest        double precision,
  meanest       double precision,
  stdev         double precision,
  highest       double precision,
  lowest        double precision,
  fetched_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_wrds_ibes_statsum_oftic_statpers
  ON wrds_research.ibes_statsum (oftic, statpers DESC);

CREATE TABLE IF NOT EXISTS wrds_research.ibes_surpsum (
  source_key    text PRIMARY KEY,
  oftic         text NOT NULL,
  ticker        text,
  measure       text,
  fiscalp       text,
  pends         date,
  anndats       date,
  actual        double precision,
  surpmean      double precision,
  surpmed       double precision,
  suescore      double precision,
  fetched_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_wrds_ibes_surpsum_oftic
  ON wrds_research.ibes_surpsum (oftic, anndats DESC NULLS LAST);

-- W4 audit panel (latest FY/FQ ratios) — never merge into FIELD_DEFS
CREATE TABLE IF NOT EXISTS wrds_research.finratio_snapshot (
  ticker        text PRIMARY KEY,
  cusip         text,
  permno        integer,
  public_date   date,
  qdate         date,
  pe_exi        double precision,
  pe_op_dil     double precision,
  bm            double precision,
  ps            double precision,
  pcf           double precision,
  roe           double precision,
  roa           double precision,
  roce          double precision,
  npm           double precision,
  gpm           double precision,
  de_ratio      double precision,
  curr_ratio    double precision,
  quick_ratio   double precision,
  at_turn       double precision,
  inv_turn      double precision,
  fetched_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS wrds_research.crsp_dsf (
  permno        integer NOT NULL,
  ticker        text,
  date          date NOT NULL,
  prc           double precision,
  ret           double precision,
  retx          double precision,
  vol           double precision,
  shrout        double precision,
  fetched_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (permno, date)
);

CREATE INDEX IF NOT EXISTS idx_wrds_crsp_dsf_ticker_date
  ON wrds_research.crsp_dsf (ticker, date DESC);
ALTER TABLE wrds_research.crsp_dsf ADD COLUMN IF NOT EXISTS openprc double precision;   -- 10-26: daily open (SMC candle body)

-- A265: CBOE vol indexes (VIX, VIX9D, VIX3M, VVIX, SKEW) — research only.
-- Primary feed: CBOE public daily CSVs (WRDS cboe.cboe has VIX/VXN/VXD only;
-- LSEG get_history blocked when monthly datapoint budget is exhausted).
CREATE TABLE IF NOT EXISTS wrds_research.cboe_daily (
  date          date NOT NULL,
  index         text NOT NULL,
  close         double precision NOT NULL,
  source        text NOT NULL DEFAULT 'cboe_cdn',
  fetched_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (date, index)
);

CREATE INDEX IF NOT EXISTS idx_wrds_cboe_daily_index_date
  ON wrds_research.cboe_daily (index, date DESC);
