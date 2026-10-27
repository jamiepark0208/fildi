-- Fildi "Model List": the model's own watchlist, shown in the app's Watchlist → Model List tab.
-- Test harness before anything reaches Robinhood. Kept apart from the user's watchlist.color_tag on purpose:
-- model tags never feed the options scanner / TAG_BONUS, and never overwrite a tag the user set.
-- Every publish is a new run (append-only), so list history can be graded later.

CREATE TABLE IF NOT EXISTS watchlist_sync.model_folders (
  folder_key   text PRIMARY KEY,
  name         text NOT NULL,
  description  text NOT NULL,
  kind         text NOT NULL,             -- action (a trade idea) | verdict (a color tag) | review (cross-check conflicts)
  sort_order   integer NOT NULL,
  max_items    integer,                   -- null = uncapped
  enabled      boolean NOT NULL DEFAULT true
);

CREATE TABLE IF NOT EXISTS watchlist_sync.model_runs (
  id             bigserial PRIMARY KEY,
  created_at     timestamptz NOT NULL DEFAULT now(),
  model_version  text NOT NULL,
  plan_id        bigint REFERENCES watchlist_sync.plans(id),
  fit_run_at     timestamptz,              -- fit_scores computed_at used
  summary        jsonb
);

CREATE TABLE IF NOT EXISTS watchlist_sync.model_items (
  id          bigserial PRIMARY KEY,
  run_id      bigint NOT NULL REFERENCES watchlist_sync.model_runs(id) ON DELETE CASCADE,
  folder_key  text NOT NULL REFERENCES watchlist_sync.model_folders(folder_key),
  ticker      text NOT NULL,
  rank        integer NOT NULL,
  verdict     text NOT NULL DEFAULT '',   -- green | yellow | red | purple | '' (judgment, independent of holding)
  role        text,                       -- held | etf | null
  status      text NOT NULL DEFAULT 'ok', -- ok | provisional | review
  score       real,
  pillars     jsonb,                      -- {own, street, premium, fit, edge}
  flags       jsonb,
  why         jsonb,
  contract    jsonb                       -- option ideas: {type, strike, expiry, premium, account, verify_status, contracts, collateral}
);
-- every adjustment applied to an item, for the UI: [{what, from, to, why}] (2026-10-05)
ALTER TABLE watchlist_sync.model_items ADD COLUMN IF NOT EXISTS adjustments jsonb;
-- a ticker can hold a put AND a call idea in one folder (POET in Needs Review), or the same contract type in two accounts (ONDS)
CREATE UNIQUE INDEX IF NOT EXISTS model_items_run_folder_ticker_contract
  ON watchlist_sync.model_items (run_id, folder_key, ticker, COALESCE(contract->>'type', ''), COALESCE(contract->>'account', ''));

-- Append-only ledger of every fit-model scoring (fit_scores keeps only the latest row per ticker).
CREATE TABLE IF NOT EXISTS watchlist_sync.fit_score_history (
  id             bigserial PRIMARY KEY,
  computed_at    timestamptz NOT NULL DEFAULT now(),
  model_version  text NOT NULL,
  ticker         text NOT NULL,
  verdict        text NOT NULL,
  role           text,
  own real, street real, premium real, fit real, edge real,
  flags          jsonb,
  why            jsonb,
  inputs         jsonb                    -- raw inputs at scoring time (point-in-time, for backtests / attribution)
);
CREATE INDEX IF NOT EXISTS fit_score_history_ticker_idx ON watchlist_sync.fit_score_history (ticker, computed_at DESC);

INSERT INTO watchlist_sync.model_folders (folder_key, name, description, kind, sort_order, max_items) VALUES
  ('sell_puts',  'Sell Puts',     'Put ideas that passed Fildi checks (L1), live Robinhood checks (L2) and the verdict cross-check', 'action', 10, 25),  -- rules.MAX_ITEMS_PUTS (10-26)
  ('rich_puts',  'Rich Puts (your rule)', 'Every put paying ≥ 0.9 %/wk at ≥ 10 % OTM, ranked by confidence (S109 real quotes); shadow: no live or account checks, graded at expiry', 'action', 12, NULL),
  ('sell_calls', 'Covered Calls', 'Call ideas on free shares that passed L1, L2 and the verdict cross-check', 'action', 20, 15),
  ('trim_risk',  'Trim / Risk',   'Held names with 2+ independent red flags', 'action', 30, 15),
  ('rebalance',  'Rebalance FILDI', 'FILDI holdings vs the per-name cap (15% of net), speculative share (40% of holdings), leverage, margin loan, crypto (display only)', 'action', 37, NULL),
  ('manage',     'Manage Open Positions', 'Your open short options: take profit, at risk / in the money, expiring soon', 'action', 35, NULL),
  ('own',        'Own (green)',   'Would happily own: strong fundamentals + credit, analysts supportive', 'verdict', 40, NULL),
  ('income',     'Income (yellow)', 'Wheel targets: rich premium on an ownable name that fits your buying power', 'verdict', 50, NULL),
  ('holdings',   'Holdings',      'Everything you hold; the dot shows the model''s verdict, not just "held"', 'verdict', 60, NULL),
  ('avoid',      'Avoid (red)',   '2+ risk flags, or weak to own and analysts negative', 'verdict', 70, NULL),
  ('context',    'Market Context', 'ETFs / funds tracked for regime and sector moves', 'verdict', 80, NULL),
  ('review',     'Needs Review',  'Trade ideas the verdict cross-check held back (e.g. passed quotes but the name is red or unscored)', 'review', 90, NULL),
  ('watch',      'Watch-only',    'Scored but nothing stands out; candidates to drop', 'verdict', 100, NULL)
ON CONFLICT (folder_key) DO UPDATE SET name = EXCLUDED.name, description = EXCLUDED.description, kind = EXCLUDED.kind,
  sort_order = EXCLUDED.sort_order, max_items = EXCLUDED.max_items;
