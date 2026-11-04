CREATE TABLE IF NOT EXISTS watchlist_sync.backtest_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  param_hash text NOT NULL,
  params jsonb NOT NULL,
  summary jsonb NOT NULL,
  trades jsonb,
  created_by text,
  holdout_unlocked boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_backtest_runs_param_hash ON watchlist_sync.backtest_runs (param_hash);
CREATE INDEX IF NOT EXISTS idx_backtest_runs_created_at ON watchlist_sync.backtest_runs (created_at DESC);
