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
  - `ticker_fundamentals` — per-field priority (varies by field family, see below).
    Written by merge-trusted.ts. Read by scorer, Stock DB view (`GET /fundamentals/stock-db`,
    now viewable by any signed-in user; mutations stay admin-only). `discrepancy_flags` /
    `override_flags` columns are comma-separated field lists the grid uses to outline cells
    (sky = divergent, blue = manual override) without a per-cell provenance fetch.
  - `field_provenance` (PK: ticker, field) — which source won + `divergent` flag.
    Written by merge-trusted.ts. Read by provenance API (GET /fundamentals/provenance/:ticker,
    admin-only) and the "Needs Review" queue (GET /fundamentals/divergent).
  - `manualOverrides` — admin per-field overrides, consumed before FIELD_DEFS priority.
  - `enrichment_runs` — one row per nightly-enrichment invocation (status/trigger/perSource/
    coverageBefore→After/error). Run history is queryable here, not just the per-day log file.

**Merge pipeline order:**
  1. Run backfill scripts (bronze) → 2. populate-source-fundamentals.ts (silver) → 3. merge-trusted.ts (gold)
  Nightly-enrichment.ts orchestrates 2+3 automatically. **They run IN-PROCESS via
  `runPopulateSourceFundamentals()` / `runMergeTrusted()` imports — NOT as `npx tsx`
  subprocesses** (the old execFileSync approach failed silently in the long-lived server;
  fixed 2026-07-23). Both scripts still have a CLI guard for standalone runs. A populate/merge
  failure now marks the enrichment_runs row `partial` instead of a false `success`.

**Per-field priority rules (hardcoded in merge-trusted.ts FIELD_DEFS)** — all 6 sources wired
in. **EDGAR is last-resort in EVERY chain** (annual 10-K data lags; it only wins when every
timelier source is null — reordered 2026-07-23). Highlights:
  - Valuation (peRatio, evEbitda, etc.): yahoo → finnhub → fmp
  - Margins/returns: yahoo → finnhub → fmp (EDGAR excluded from the divergence check for these
    TTM fields — period mismatch)
  - Balance sheet: yahoo → finnhub → fmp → polygon → edgar(last)
  - Income statement: yahoo → fmp → polygon → edgar(last)
  - Cash flow: yahoo → fmp → edgar(last)
  - debtToEquity: yahoo → fmp (never finnhub — definitional mismatch)
  - wacc, roic, priceToSales, effectiveTaxRate: fmp only (Yahoo never carries these)
  - **cashAndEquivalents: yahoo `totalCash` ONLY** — concept = "cash + ST investments" (UI
    "Cash & ST Inv" label, what cashRunway needs). FMP/EDGAR report cash-only and are excluded.
  - **totalDebt: yahoo → fmp only** — Polygon/EDGAR dropped (unreliable: Polygon includes bank
    deposits e.g. GS=$1.68T, EDGAR often long-term only e.g. MSFT=$43B).
  - **revenueGrowthYoY / epsGrowth: annual-YoY basis** — yahoo `annualRevenueYoy`/`epsGrowth`
    (both annual, match FMP exactly) preferred; Yahoo quarterly + Finnhub TTM are last-resort.

**Divergence ("Needs Review") logic** (merge-trusted.ts `isMaterialDivergence`): winner-vs-
fallback, period-aware, materiality-based — NOT all-pairs. Flags only when the value we chose
materially disagrees with its next period-comparable fallback: sign flip, ≥3× scale/unit error,
or beyond a field-class tolerance (growth 50%, price ratios 25%, totalDebt 35%, margins/$ 20%)
with a 0.03 absolute floor. Do NOT confuse with `validate-sources.ts` (a separate QA report).
See fundamentals-field-definitions memory for the full canonical-concept rationale.

**Rate limits** (nightly-enrichment.ts `SOURCE_DAILY_LIMITS`, read from `api_usage`):
  - FMP: budgeted 220 calls/day (free tier is 250; margin left for ad-hoc calls). 9 calls/ticker.
    NOTE: FMP self-records usage even on nodata, so a nodata-heavy run still consumes budget.
  - AV: 25 calls/day. Reserved for tickers where free sources all fail.
  - yahoo/edgar/finnhub/polygon: no hard daily cap (rate-limited only).
  - Scheduled biweekly (Sun + Thu 02:00 UTC) via lib/scheduler.ts; also runnable manually.

**Backfill script locations (api-server/src/scripts/):**
  - backfill-fmp.ts      — skip if fmp_wacc/fmp_roic non-null AND fetchedAt < 7 days
  - backfill-polygon.ts  — skip if Yahoo/Edgar already cover all Polygon fields
  - backfill-av.ts       — skip if Yahoo covers all AV fields; resumable cursor
  - backfill-yahoo.ts    — targets fmp_fundamentals tickers not yet in yahoo_fundamentals
  - backfill-edgar.ts    — wired into merge-trusted.ts FIELD_DEFS, needs tickerCik lookup first
  - audit-coverage.ts / validate-sources.ts — QA scripts, not part of the write pipeline
  All backfill-*.ts scripts support --dry-run.
