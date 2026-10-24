---
name: fildi-market-data
description: Pick and use FILDI's data sources (LSEG, WRDS/IBES, Schwab, Polygon, tastytrade, FRED, local Postgres research tables, Crawl4AI web pages) with their budgets, venvs and gotchas. Use before pulling or querying market/fundamental/option data for a study or feature — any agent.
---

# Which source, how, and what it costs
Router only. The how-to for each source stays in its playbook; this page says which one to open.

| Need | First choice | Notes / budget | How-to |
|---|---|---|---|
| Daily OHLCV + ATM IV30/60/90, 2016→, ~273 names | `lseg_research.daily_history` (local PG) | split-adjusted to today's shares → `split_factor()` in `analysis/s049_panic_puts.py` for traded prices | `research/lseg/PLAYBOOK.md` |
| Historical option bid/ask/mid/IV, incl. expired, 2020-12→ | `research/lseg/option_prices.history()` (LSEG venv) | caches every RIC (hits **and** misses) in `optlab.lseg_opt_daily` / `lseg_opt_fetched`; 1 request per new RIC | same |
| Earnings dates + reactions | `lseg_research.earnings_moves` (move_pct in **%**), `lseg_research.events` | true report dates (A114); never fiscal period ends | `research/studies/CONVENTIONS.md` |
| StarMine alpha / predicted surprise / PT mean, monthly 2019→ | `lseg_research.starmine_history` | point-in-time by `obs_date` | `research/lseg/PLAYBOOK.md` |
| IBES estimates / revisions / growth | `wrds_research.ibes_statsum` (key `oftic`), weekly features in `watchlist_sync.lab_fund` | academic license: research only, never live scores; one WRDS job at a time | `research/wrds/PLAYBOOK.md` |
| Weekly research panel (features + outcomes) 2020→ | `watchlist_sync.lab_outcomes`, `lab_tech`, `lab_fund` | the default for factor studies | `research/studies/PLAYBOOK.md` §2 |
| Live quotes / chains / account | Schwab (API server) | 100 requests/min shared with the app — never for backtests | `.claude/skills/options-pricer.md`, `data-architecture.md` |
| Option trade bars (no quotes), minute bars | Polygon | 5 calls/min | `analysis/option_history.py` |
| IV rank / IV percentile / liquidity rating / per-expiry IV, today only (no vendor history; ours accumulates daily from 2026-10-24) | tastytrade `/market-metrics` → `vendor_raw` source `tastytrade` (daily.py step `tastytrade.py universe`) | 100 symbols per call, ~3 calls/day; `BRK.B` → `BRK/B` | `scripts/watchlist_sync/tastytrade.py` |
| Outside options backtest (short/long legs by delta, DTE, entry/exit rules; 147 symbols, 2013→) | tastytrade backtester (`tastytrade.py backtest spec.json`) | stored by spec hash, a stored spec never re-runs; one at a time | same |
| Rates / macro series | FRED CSV (`fredgraph.csv?id=DTB3`), cache under `out/` | free, no key | — |
| Web pages / papers | `scripts/fetch-page.sh <url>` (Crawl4AI, local) | `--save` only when a study cites it | AGENTS rule 10 |
| Long text classification / file triage | OpenJev (`scripts/oj.py`) | tier rules in `.agents/openjev/REGISTRY.md`; never numbers or forecasts | `.agents/openjev/README.md` |

## Budgets and guards
- **LSEG: 10k requests/day across all apps, ≤ 5/s.** `research/lseg/_session.py` refuses to *start* above 80 % of today's use (production keeps the last 20 %). It does **not** stop a long run mid-way, so research scripts must set their own cap (`REQ_CAP`, see `analysis/s064_buy_zone.py`). Today's use: `SELECT calls_made FROM api_usage WHERE source = 'lseg' AND date = current_date`.
- LSEG needs the Workspace desktop app running and logged in (proxy 127.0.0.1 — port from `Data API Proxy/.portInUse`, usually 9000 or 9001; health probes both). Run LSEG scripts with `research/lseg/.venv/bin/python` from `research/lseg/`.
- Python: `scripts/watchlist_sync/.venv` (numpy, no scipy) for lab work; `research/wrds/.venv` (csv/gzip; pandas datetime ops segfault on 3.14).
- DB: `from build_plan import connect` (scripts/watchlist_sync). Escape `%` as `%%` in LIKE patterns.
- `prices_historical` only starts 2025-04 → never backtest on it.
- tastytrade: OAuth refresh token (`TASTYTRADE_*` in `.env.local`) → 15-min access token; `User-Agent` required. Backtester is a different host (`backtester.vast.tastyworks.com`) and needs the `openid` scope. Metered in `api_usage` source `tastytrade`; no published daily cap → back off on 429. Research/display only, never orders (grant is `read openid`).

## Gotchas that already cost a study
- Bars with low > high, or a flat bar at the window high, break volume-profile helpers → sanitize high/low on load (S064).
- TMO and a few others have no `daily_history` rows → check coverage before quoting a universe size.
- `ticker_technicals.iv_rank` is a realized-vol proxy (`iv_rank_source = rv_proxy`), not IV rank: Spearman 0.22 vs tastytrade's real IV rank (10-24). For IV rank use the LSEG 1-year percentile (`fit_model_v14.iv_ranks`, ~130 names) or tastytrade (~267).
- Strike ladders: each guessed strike that isn't listed costs one LSEG request; walk down from the target, cap the walk.
