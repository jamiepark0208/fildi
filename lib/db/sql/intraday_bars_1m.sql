-- A126 Phase 1b — Polygon 1m bars (applied by intraday_1m_backfill.py DDL too).
-- Idempotent — safe to re-run.

CREATE SCHEMA IF NOT EXISTS watchlist_sync;

CREATE TABLE IF NOT EXISTS watchlist_sync.intraday_bars_1m (
  ticker text NOT NULL,
  ts timestamptz NOT NULL,
  o double precision NOT NULL,
  h double precision NOT NULL,
  l double precision NOT NULL,
  c double precision NOT NULL,
  v double precision NOT NULL DEFAULT 0,
  source text NOT NULL DEFAULT 'polygon',
  PRIMARY KEY (ticker, ts)
);

CREATE INDEX IF NOT EXISTS idx_intraday_bars_1m_ts
  ON watchlist_sync.intraday_bars_1m (ts DESC);

CREATE TABLE IF NOT EXISTS watchlist_sync.intraday_1m_chunks (
  ticker text NOT NULL,
  from_date date NOT NULL,
  to_date date NOT NULL,
  n int NOT NULL DEFAULT 0,
  fetched_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (ticker, from_date, to_date)
);
