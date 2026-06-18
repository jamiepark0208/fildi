CREATE TABLE IF NOT EXISTS stock_buckets (
  user_id  INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  ticker   TEXT    NOT NULL,
  bucket   TEXT    NOT NULL CHECK (bucket IN ('BULLISH', 'NEUTRAL', 'BEARISH')),
  added_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, ticker)
);

CREATE INDEX IF NOT EXISTS idx_stock_buckets_user ON stock_buckets(user_id);
CREATE INDEX IF NOT EXISTS idx_stock_buckets_ticker ON stock_buckets(ticker);
