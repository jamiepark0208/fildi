-- S131 / A314 — intraday watchlist breadth (% above open / VWAP), 5m bars.
-- hist160 = full optlab.bars_5m cross-section; live19 = Schwab 1m poll rollup (A314 Live).
-- Idempotent — safe to re-run.

CREATE SCHEMA IF NOT EXISTS optlab;

CREATE TABLE IF NOT EXISTS optlab.breadth_5m (
  ts timestamptz NOT NULL,
  d date NOT NULL,
  n int NOT NULL,
  up_open double precision NOT NULL,
  above_vwap double precision NOT NULL,
  mean_ret double precision NOT NULL,
  src text NOT NULL DEFAULT 'hist160'
);

ALTER TABLE optlab.breadth_5m
  ADD COLUMN IF NOT EXISTS src text NOT NULL DEFAULT 'hist160';

UPDATE optlab.breadth_5m SET src = 'hist160' WHERE src IS NULL OR src = '';

CREATE INDEX IF NOT EXISTS idx_breadth_5m_d_src_ts
  ON optlab.breadth_5m (d, src, ts);
