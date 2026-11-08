-- A192 Part S1 — per-stock vol surface (Refs: A192)
CREATE SCHEMA IF NOT EXISTS optlab;

CREATE TABLE IF NOT EXISTS optlab.stock_surface_daily (
  ticker text NOT NULL,
  as_of date NOT NULL,
  expiry date NOT NULL,
  dte int NOT NULL,
  source text NOT NULL,
  n_quotes int NOT NULL,
  fwd double precision,
  atm_iv double precision,
  a double precision,
  b double precision,
  c double precision,
  rmse double precision,
  rr25 double precision,
  bf25 double precision,
  iv10p double precision,
  iv10c double precision,
  flags text,
  PRIMARY KEY (ticker, as_of, expiry, source)
);

CREATE INDEX IF NOT EXISTS stock_surface_daily_as_of ON optlab.stock_surface_daily (as_of);
CREATE INDEX IF NOT EXISTS stock_surface_daily_ticker ON optlab.stock_surface_daily (ticker);

CREATE TABLE IF NOT EXISTS optlab.stock_surface_cm (
  ticker text NOT NULL,
  as_of date NOT NULL,
  tenor int NOT NULL,
  atm_iv double precision,
  b double precision,
  c double precision,
  rr25 double precision,
  bf25 double precision,
  term_30_90 double precision,
  ex_earn_atm_iv double precision,
  PRIMARY KEY (ticker, as_of, tenor)
);

CREATE TABLE IF NOT EXISTS optlab.stock_realized_daily (
  ticker text NOT NULL,
  as_of date NOT NULL,
  rv20 double precision,
  rv60 double precision,
  semivar_ratio60 double precision,
  rskew60 double precision,
  PRIMARY KEY (ticker, as_of)
);
