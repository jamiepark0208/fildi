---
name: db-patterns
description: PostgreSQL schema and query rules for TradeDash. Read before any schema or migration work.
---

Core tables:

watchlist:
  ticker TEXT PRIMARY KEY
  tier INTEGER (1, 2, or 3)
  status TEXT — want_to_own | assigned | monitoring | closed
  added_at TIMESTAMPTZ DEFAULT NOW()
  notes TEXT

positions:
  id SERIAL PRIMARY KEY
  account_id TEXT NOT NULL
  ticker TEXT NOT NULL
  position_type TEXT — short_put | short_call | long_stock | long_call | long_put
  strike NUMERIC
  expiry DATE
  qty INTEGER NOT NULL
  avg_price NUMERIC NOT NULL
  opened_at TIMESTAMPTZ DEFAULT NOW()
  closed_at TIMESTAMPTZ
  pnl NUMERIC

signal_log:
  id SERIAL PRIMARY KEY
  ticker TEXT NOT NULL
  fired_at TIMESTAMPTZ DEFAULT NOW()
  rsi_at_fire NUMERIC
  mfi_at_fire NUMERIC
  return_5d NUMERIC
  rm_result TEXT — proceed | check_catalyst | exclude
  catalyst_found TEXT
  strike NUMERIC
  expiry DATE
  premium NUMERIC
  income_pct NUMERIC
  vix_at_fire NUMERIC
  outcome TEXT — win | loss | assigned | pending

prices_historical:
  ticker TEXT NOT NULL
  date DATE NOT NULL
  open NUMERIC, high NUMERIC, low NUMERIC, close NUMERIC, volume BIGINT
  PRIMARY KEY (ticker, date)

Required indexes:
  CREATE INDEX idx_positions_ticker ON positions(ticker);
  CREATE INDEX idx_signal_log_ticker ON signal_log(ticker, fired_at DESC);
  CREATE INDEX idx_prices_lookup ON prices_historical(ticker, date DESC);

Rules:
  - Parameterized queries only — never string interpolation
  - Use ON CONFLICT DO UPDATE for upserts, never DELETE+INSERT
  - Connection pool max 5 (Replit free tier limit)
  - Historical prices: INSERT OR IGNORE — never re-fetch what exists
