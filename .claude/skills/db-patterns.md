---
name: db-patterns
description: PostgreSQL schema and query rules for TradeDash. Read before any schema or migration work.
---

Full schema (37 tables, with column-level comments) lives at `lib/db/src/schema/index.ts` —
that file is the source of truth for columns; this doc is a map of what exists and why, not
a column mirror (column mirrors go stale, e.g. `source_ticker_map` drifted from its actual
schema for a while — see `data-agent.md`'s changelog note).

## Table inventory by domain

**Auth/admin:** `users` (role admin/member), `inviteCodes` (registration gate)

**Watchlist/trading core:**
  - `watchlist` — per-user ticker + tier + status (want_to_own/assigned/monitoring/closed)
  - `tickerConfig` — static per-ticker RSI threshold/tier, editable without deploy
  - `positions` — user's manually-entered option/stock positions (distinct from the
    Robinhood CSV portfolio-ingest pipeline below)
  - `userPortfolioNames` — named portfolio groupings
  - `pricesHistorical` — OHLCV, PK (ticker, date)
  - `signalLog` — designed to log fired RSI/MFI signals with outcome tracking.
    **Currently unused — no code reads or writes it.** Don't assume it's wired up.

**Analyst events (bronze/gold pair):** `yahooAnalystActions` (raw) → `analystEvents` (normalized)

**Indicator/technical scoring — two separate, both-live systems, not one superseding the other:**
  - `indicatorCache` — simpler per-ticker RSI/MFI GO/WATCH/NO signal, one row per (ticker, date).
    Populated by `lib/seeder.ts` at server boot for tickers missing today's row, plus on-demand
    via `GET /api/indicators/:ticker?refresh=true`. Still rendered in `technical.tsx` and
    `options-scanner.tsx` alongside the V2 scorer below — not legacy/dead.
  - `tickerTechnicals` — the primary "V2" scorer, 55+ columns (momentum/volume/volatility/MAs/
    support-resistance/regime/options flow/earnings). See `technical-scorecard.md` for the full
    pipeline (`computeTechnicalRankingsV2` → this table → `GET /api/technicals/all`).

**Fundamentals pipeline (Bronze → Silver → Gold)** — see dedicated section below.

**Fundamentals support:**
  - `apiUsage` — unified per-source per-day call counter (fmp/av/polygon/finnhub/yahoo/edgar/
    fred/cnn); `fmpApiUsage` is a legacy single-row FMP counter kept for backward compat only —
    new code should use `apiUsage`.
  - `tickerFundamentalsHistory` — annual historical fundamentals, used for scorer self-relative
    scoring
  - `dataSources` — provider priority/daily-limit tracker
  - `earningsCalendar` — scheduled/historical earnings. **Currently unused — no code reads or
    writes it.**
  - `tickerCik` — EDGAR CIK lookup cache
  - `sourceTickerMap` — maps internal ticker → source-specific symbol alias (e.g. BRK.B vs
    BRK-B), PK (ticker, source). Columns: `ticker, source, sourceTicker, active, notes,
    createdAt`.
  - `unmappedTickers` — tickers `classifyTicker` couldn't map to a peer group, for manual review
  - `appConfig` — generic key/value store; also persists last-enrichment-run timestamp
  - `explainCache` — AI-generated score explanation cache, keyed by (ticker, scoreType, scoreHash)

**Peer/ticker registry:**
  - `peerGroups` / `peerGroupMembers` — logical peer groups + scoring_mode, junction table
  - `tickerRegistry` — master ticker universe with sector, peers, index memberships,
    `fetchFundamentals` flag. Richer metadata store for the same universe `fmp_fundamentals`
    gates membership on (see "Canonical universe" below) — read very widely across backfill
    scripts and `lib/peer-resolver.ts`.

**Social feed:** `tradePosts`, `likes`, `comments`, `stockBuckets` (per-user bullish/neutral/
bearish ticker categorization)

**Portfolio ingest** (Robinhood CSV import pipeline, FK'd to `portfolioSnapshots.id`):
  `portfolioSnapshots` (one row per CSV import) → `portfolioAccountSummaries`,
  `portfolioPositions`, `portfolioEquityFundamentals`, `portfolioOptions`, `portfolioOrders`
  (one row per line-item). Written by `routes/portfolio-ingest.ts`, admin-only (see
  `data-architecture.md`'s permissions note).

**Regime:** `marketRegime` — one row per classifier run (expansion/late_cycle/contraction/
recession/recovery/stagflation + confidence + JSONB signal scores). Prune manually to last 90
rows per schema comment — no automated pruning exists.

## Required indexes (verify still present before adding a new hot query)
  CREATE INDEX idx_positions_ticker ON positions(ticker);
  CREATE INDEX idx_prices_lookup ON prices_historical(ticker, date DESC);

## Rules
  - Parameterized queries only — never string interpolation
  - Use ON CONFLICT DO UPDATE for upserts, never DELETE+INSERT
  - Connection pool max: `DATABASE_POOL_MAX` env var, default 20 (`lib/db/src/index.ts`) —
    shared across Drizzle + connect-pg-simple sessions, see bugs/6 before changing
  - Historical prices: INSERT OR IGNORE — never re-fetch what's already in prices_historical

## Fundamentals data layers (Bronze → Silver → Gold)

**Canonical universe**: `fmp_fundamentals` table — never hardcode a ticker count, it drifts
(see CLAUDE.md). Always query this for ticker universe membership, not peer_group_members or
ticker_registry (those hold richer per-ticker metadata for the same tickers, not membership).

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
    Written by merge-trusted.ts. Read by scorer, Stock DB view (`GET /fundamentals/stock-db`,
    now viewable by any signed-in user; mutations stay admin-only).
  - `field_provenance` (PK: ticker, field) — which source won + divergence flag.
    Written by merge-trusted.ts. Read by provenance API (GET /fundamentals/provenance/:ticker,
    admin-only).
  - `manualOverrides` — admin per-field overrides, consumed before FIELD_DEFS priority.

**Merge pipeline order:**
  1. Run backfill scripts (bronze) → 2. populate-source-fundamentals.ts (silver) → 3. merge-trusted.ts (gold)

**Per-field priority rules (hardcoded in merge-trusted.ts FIELD_DEFS)** — all 6 sources are
wired in, including EDGAR and Polygon/AV as lowest-priority fallbacks (not "cross-validation
only" — see data-agent.md's changelog):
  - Valuation (peRatio, evEbitda, etc.): yahoo → finnhub → fmp
  - Margins/returns: yahoo → finnhub → fmp (never edgar — period mismatch)
  - Balance sheet: yahoo → finnhub → edgar → fmp → polygon/av fallback
  - Income statement: yahoo → fmp → edgar → polygon/av fallback
  - Cash flow: yahoo → fmp → edgar
  - debtToEquity: yahoo → fmp (never finnhub — definitional mismatch)
  - wacc, roic, priceToSales, effectiveTaxRate: fmp only (Yahoo never carries these)

**Rate limits:**
  - FMP: 250 calls/day (free tier). 9 calls/ticker × 257 tickers = ~10 days. Budget tracked in `api_usage`.
  - AV: 25 calls/day. Resumable cursor in logs/av-cursor.json. ~10+ days to cover 257 tickers.
  - Polygon: no hard daily limit. 3 concurrent, 1s between batches.

**Backfill script locations (api-server/src/scripts/):**
  - backfill-fmp.ts      — skip if fmp_wacc/fmp_roic non-null AND fetchedAt < 7 days
  - backfill-polygon.ts  — skip if Yahoo/Edgar already cover all Polygon fields
  - backfill-av.ts       — skip if Yahoo covers all AV fields; resumable cursor
  - backfill-yahoo.ts    — targets fmp_fundamentals tickers not yet in yahoo_fundamentals
  - backfill-edgar.ts    — wired into merge-trusted.ts FIELD_DEFS, needs tickerCik lookup first
  - audit-coverage.ts / validate-sources.ts — QA scripts, not part of the write pipeline
  All backfill-*.ts scripts support --dry-run.
