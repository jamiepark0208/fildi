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

## Fundamentals data layers (Bronze → Silver → Gold)

**Canonical universe**: `fmp_fundamentals` table — never hardcode a ticker count, it drifts
(see CLAUDE.md). Always query this for the ticker universe, not peer_group_members or ticker_registry.

**Bronze (staging) — one row per ticker, source-prefixed columns:**
  - `fmp_fundamentals`      — 37 data columns, `fmp_` prefix. Written by backfill-fmp.ts
  - `yahoo_fundamentals`    — 38 data columns, `yahoo_` prefix. Written by backfill-yahoo.ts
  - `finnhub_fundamentals`  — prefixed columns. Written by backfill-finnhub.ts
  - `edgar_fundamentals`    — prefixed columns. Written by backfill-edgar.ts
  - `polygon_fundamentals`  — 8 data columns, `polygon_` prefix. Written by backfill-polygon.ts
  - `av_fundamentals`       — 12 data columns, `av_` prefix. Written by backfill-av.ts

**Silver (normalized) — one row per (ticker, source, field):**
  - `source_fundamentals` (PK: ticker, source, field) — canonical field names, all sources.
    Written by populate-source-fundamentals.ts. Read by merge-trusted.ts and provenance API.

**Gold (merged) — one row per ticker:**
  - `ticker_fundamentals` — per-field priority: yahoo → finnhub → edgar → fmp (varies by field family).
    Written by merge-trusted.ts. Read by scorer, Stock DB admin view.
  - `field_provenance` (PK: ticker, field) — which source won + divergence flag.
    Written by merge-trusted.ts. Read by provenance API (GET /fundamentals/provenance/:ticker).

**Merge pipeline order:**
  1. Run backfill scripts (bronze) → 2. populate-source-fundamentals.ts (silver) → 3. merge-trusted.ts (gold)

**Per-field priority rules (hardcoded in merge-trusted.ts FIELD_DEFS):**
  - Valuation (peRatio, evEbitda, etc.): yahoo → finnhub → fmp
  - Margins/returns: yahoo → finnhub → fmp (never edgar — period mismatch)
  - Balance sheet: yahoo → finnhub → edgar → fmp
  - Income statement: yahoo → fmp → edgar
  - Cash flow: yahoo → fmp → edgar
  - debtToEquity: yahoo → fmp (never finnhub — definitional mismatch)
  - wacc, roic, priceToSales, effectiveTaxRate: fmp only (Yahoo never carries these)

**Rate limits:**
  - FMP: 250 calls/day (free tier). 9 calls/ticker × 257 tickers = ~10 days. Budget tracked in fmp_api_usage.
  - AV: 25 calls/day. Resumable cursor in logs/av-cursor.json. ~10+ days to cover 257 tickers.
  - Polygon: no hard daily limit. 3 concurrent, 1s between batches.

**Backfill script locations (api-server/src/scripts/):**
  - backfill-fmp.ts      — skip if fmp_wacc/fmp_roic non-null AND fetchedAt < 7 days
  - backfill-polygon.ts  — skip if Yahoo/Edgar already cover all Polygon fields
  - backfill-av.ts       — skip if Yahoo covers all AV fields; resumable cursor
  - backfill-yahoo-canonical.ts — one-shot, targets fmp_fundamentals NOT IN yahoo_fundamentals
  All support --dry-run flag.
