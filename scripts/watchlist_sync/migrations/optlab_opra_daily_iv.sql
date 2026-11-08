CREATE TABLE IF NOT EXISTS optlab.opra_daily_iv (
  occ text NOT NULL,
  ticker text NOT NULL,
  expiry date NOT NULL,
  side text NOT NULL,
  strike double precision NOT NULL,
  date date NOT NULL,
  bar_ts timestamptz,
  opt_px double precision,
  stock_px double precision,
  iv double precision,
  delta double precision,
  volume bigint,
  trades bigint,
  flags text,
  fetched_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (occ, date)
);
CREATE INDEX IF NOT EXISTS idx_opra_daily_iv_td ON optlab.opra_daily_iv (ticker, date);
CREATE INDEX IF NOT EXISTS idx_opra_daily_iv_group ON optlab.opra_daily_iv (ticker, date, expiry);

CREATE TABLE IF NOT EXISTS optlab.opra_fetch_log (
  occ text NOT NULL,
  date_from date NOT NULL,
  date_to date NOT NULL,
  status text NOT NULL,
  n_bars int,
  fetched_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (occ, date_from, date_to)
);
