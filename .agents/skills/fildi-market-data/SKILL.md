---
name: fildi-market-data
description: Pick and use FILDI's data sources (LSEG, WRDS/IBES, Schwab, Polygon, FRED, local Postgres research tables, Crawl4AI web pages) with their budgets, venvs and gotchas. Use before pulling or querying market/fundamental/option data for a study or feature — any agent.
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
| Rates / macro series | FRED CSV (`fredgraph.csv?id=DTB3`), cache under `out/` | free, no key | — |
| Web pages / papers | `scripts/fetch-page.sh <url>` (Crawl4AI, local) | `--save` only when a study cites it | AGENTS rule 10 |
| Long text classification / file triage | OpenJev (`scripts/oj.py`) | tier rules in `.agents/openjev/REGISTRY.md`; never numbers or forecasts | `.agents/openjev/README.md` |

## Budgets and guards
- **LSEG: 10k requests/day across all apps, ≤ 5/s.** `research/lseg/_session.py` refuses to *start* above 80 % of today's use (production keeps the last 20 %). It does **not** stop a long run mid-way, so research scripts must set their own cap (`REQ_CAP`, see `analysis/s064_buy_zone.py`). Today's use: `SELECT calls_made FROM api_usage WHERE source = 'lseg' AND date = current_date`.
- LSEG needs the Workspace desktop app running and logged in (proxy 127.0.0.1:9000). Run LSEG scripts with `research/lseg/.venv/bin/python` from `research/lseg/`.
- Python: `scripts/watchlist_sync/.venv` (numpy, no scipy) for lab work; `research/wrds/.venv` (csv/gzip; pandas datetime ops segfault on 3.14).
- DB: `from build_plan import connect` (scripts/watchlist_sync). Escape `%` as `%%` in LIKE patterns.
- `prices_historical` only starts 2025-04 → never backtest on it.

## Gotchas that already cost a study
- Bars with low > high, or a flat bar at the window high, break volume-profile helpers → sanitize high/low on load (S064).
- TMO and a few others have no `daily_history` rows → check coverage before quoting a universe size.
- Strike ladders: each guessed strike that isn't listed costs one LSEG request; walk down from the target, cap the walk.
