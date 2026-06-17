-- Profile stock picks (Bullish / Neutral / Bearish ticker lists per user)
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS stock_picks jsonb NOT NULL DEFAULT '{"bullish":[],"neutral":[],"bearish":[]}'::jsonb;
