-- Fildi → Robinhood watchlist sync. Plans are built from Fildi's own tables (L1 checks), then each item is
-- verified against live Robinhood quotes (L2) before anything is ever written to Robinhood (Phase 2).
CREATE SCHEMA IF NOT EXISTS watchlist_sync;

CREATE TABLE IF NOT EXISTS watchlist_sync.lists (
  list_key     text PRIMARY KEY,           -- sell_puts | sell_calls | trim_risk | buy | earnings | long_calls | long_puts
  display_name text NOT NULL,              -- name in Robinhood, always prefixed "Fildi ·"
  emoji        text,
  enabled      boolean NOT NULL DEFAULT false,
  max_items    integer NOT NULL DEFAULT 15,
  rh_list_id   text,                       -- set once created; writes go by id, never by name
  phase        integer NOT NULL DEFAULT 1,
  notes        text
);

CREATE TABLE IF NOT EXISTS watchlist_sync.plans (
  id           bigserial PRIMARY KEY,
  created_at   timestamptz NOT NULL DEFAULT now(),
  close_date   date NOT NULL,              -- trading close the plan is for
  status       text NOT NULL DEFAULT 'draft', -- draft | verified | applied | rejected | expired
  inputs       jsonb,                      -- freshness of every input used
  summary      jsonb,
  verified_at  timestamptz,
  applied_at   timestamptz
);

CREATE TABLE IF NOT EXISTS watchlist_sync.plan_items (
  id             bigserial PRIMARY KEY,
  plan_id        bigint NOT NULL REFERENCES watchlist_sync.plans(id) ON DELETE CASCADE,
  list_key       text NOT NULL,
  ticker         text NOT NULL,
  rank           integer,
  score          double precision,
  kind           text NOT NULL,            -- option | stock
  option_type    text,
  strike         numeric,
  expiry         date,
  account        text,                     -- account that can carry it (collateral / covered shares)
  model_premium  numeric,
  model_spot     numeric,
  model_delta    numeric,
  model_iv       numeric,
  l1_pass        boolean NOT NULL,
  l1_checks      jsonb NOT NULL,           -- [{check, pass, severity, detail}]
  reasons        jsonb,                    -- plain-English why it's on the list
  verify_status  text NOT NULL DEFAULT 'pending', -- pending | pass | pass_after_hours | fail | not_required
  verify_checks  jsonb,
  live           jsonb,                    -- broker quote snapshot used for verification
  UNIQUE (plan_id, list_key, ticker)
);

-- Raw Robinhood responses used in verification (audit trail; never re-fetched for the same plan).
CREATE TABLE IF NOT EXISTS watchlist_sync.rh_raw (
  id          bigserial PRIMARY KEY,
  plan_id     bigint NOT NULL REFERENCES watchlist_sync.plans(id) ON DELETE CASCADE,
  kind        text NOT NULL,               -- instruments | option_quotes | equity_quotes
  payload     jsonb NOT NULL,
  fetched_at  timestamptz NOT NULL DEFAULT now()
);

INSERT INTO watchlist_sync.lists (list_key, display_name, emoji, enabled, max_items, phase, notes) VALUES
  ('sell_puts',  'Fildi · Sell Puts',      '🟢', true,  15, 1, 'model_recs puts that pass L1+L2 and fit available collateral'),
  ('sell_calls', 'Fildi · Covered Calls',  '🟡', true,  15, 1, 'model_recs calls on names held ≥100 shares in one account'),
  ('trim_risk',  'Fildi · Trim / Risk',    '🔴', true,  15, 1, 'held names with ≥2 independent red flags'),
  ('earnings',   'Fildi · Earnings Setups','📅', false, 10, 2, 'reports ≤7d with RICH premium verdict'),
  ('buy',        'Fildi · Buy',            '🔵', false, 15, 3, 'after Cursor score upgrades land'),
  ('long_calls', 'Fildi · Long Calls',     '📈', false, 10, 4, 'needs a graded directional model first'),
  ('long_puts',  'Fildi · Long Puts',      '📉', false, 10, 4, 'needs a graded directional model first')
ON CONFLICT (list_key) DO NOTHING;

-- Strategy Library (A175/A176): backtested strategies the Track Record › Strategies tab reads. Written only by
-- analysis/strategy_lib.py (delete + insert per strategy version); the page and API never compute trades.
CREATE TABLE IF NOT EXISTS watchlist_sync.strategies (
  strategy_id    text NOT NULL,
  version        text NOT NULL,
  name           text NOT NULL,
  family         text NOT NULL,            -- options-income | tail/long-option | stock-swing | index
  instrument     text NOT NULL,            -- stock | option | mixed
  status         text NOT NULL,            -- live | candidate | failed | retired
  summary        text NOT NULL,            -- one line
  rules_md       text NOT NULL,
  caveats_md     text,
  study_ref      text,                     -- e.g. S046 / A171
  window_start   date NOT NULL,
  window_end     date NOT NULL,
  holdout_start  date,                     -- NULL = nothing tuned → no holdout split
  price_source   text NOT NULL,            -- real_quote | close | model
  updated_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (strategy_id, version)
);

CREATE TABLE IF NOT EXISTS watchlist_sync.strategy_trades (
  id            bigserial PRIMARY KEY,
  strategy_id   text NOT NULL,
  version       text NOT NULL,
  entry_ts      timestamptz NOT NULL,
  exit_ts       timestamptz,
  ticker        text NOT NULL,
  instrument    text NOT NULL,             -- stock | option
  side          text NOT NULL,             -- long | short
  option_type   text,                      -- P | C | NULL for stock
  strike        double precision,
  expiry        date,
  dte_at_entry  int,
  qty           double precision NOT NULL,
  entry_px      double precision NOT NULL,
  exit_px       double precision,
  capital       double precision NOT NULL, -- $ at risk (collateral for short puts)
  pnl           double precision,
  ret_pct       double precision,          -- pnl ÷ capital
  trigger       text NOT NULL,             -- plain words: why it fired
  exit_reason   text,
  is_holdout    boolean NOT NULL DEFAULT false,
  FOREIGN KEY (strategy_id, version) REFERENCES watchlist_sync.strategies ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS strategy_trades_sv ON watchlist_sync.strategy_trades (strategy_id, version, entry_ts);

CREATE TABLE IF NOT EXISTS watchlist_sync.strategy_equity (
  strategy_id  text NOT NULL,
  version      text NOT NULL,
  d            date NOT NULL,
  equity       double precision NOT NULL,  -- index, starts at 1.0
  spy_equity   double precision NOT NULL,  -- SPY buy-and-hold, same base
  drawdown     double precision NOT NULL,  -- equity ÷ running max − 1
  is_holdout   boolean NOT NULL DEFAULT false,
  PRIMARY KEY (strategy_id, version, d),
  FOREIGN KEY (strategy_id, version) REFERENCES watchlist_sync.strategies ON DELETE CASCADE
);
