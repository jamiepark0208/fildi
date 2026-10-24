# Job host split — Mac-private vs public/portable (A211 stage 1)
**Date measured:** 2026-10-24 · **Owner:** Cursor · **Refs:** A211, A241  
**Scope:** inventory + RSS + schema sizes + never-receive. No migration. No `daily.py` read-path edits.

Tag legend: **private** = must stay on Mac · **portable** = can run on a public DB host · **needs-change** = looks portable but couples to private paths today.

---

## (a) Job inventory (`INVENTORY_SPEC` + `EXPECTED_LAUNCH_AGENTS`)

### Scheduler / catalog jobs (`scheduled-tasks-inventory.ts` `INVENTORY_SPEC`)

| taskId | tag | Private tables / files touched |
|---|---|---|
| maintain | **needs-change** | Mixed: public enrich/prices/scores + shells `daily.py` (book), LSEG probe, osascript, caffeinate, resource_snapshots. Split via `maintain --public` later (A241 P3). |
| ops-digest | portable | Markdown/json under `.cursor/context/` only (no holdings). |
| enrichment-api | portable | `enrichment_runs`, fundamentals (legacy; off on Mac). |
| event-bullets | portable | `ticker_event_bullets` / watchlist bullets. |
| earnings-backfill | portable | earnings history tables. |
| fmp-analyst-feed | **needs-change** | FMP archive = portable; `street_pt_daily` LSEG leg = private/licensed → split or Mac-only half. |
| desk-ingest | **private** | `desk_commentaries` from Mac Google Drive sync folder. |
| schwab-health | **private** | Schwab token file on Mac. |
| schwab-1m | **private** | Schwab writer → `watchlist_sync.intraday_bars_1m` (table may be public; writer is private). |
| research-ops-health | **private** | Probes Mac LSEG/WRDS desktop reachability. |
| lseg-daily-sync | **private** | `lseg_research.*` + Workspace `:9000`. |
| lseg-weekly-sync | **private** | same. |
| wrds-monthly-ibes | **private** | `wrds_research.*` + Duo. |
| wrds-quarterly-crsp | **private** | same. |
| pm-alerts | **private** | `pm_alerts`, `pm_book_latest`, `forecast_ledger` (book). |
| openjev | **private** | local model + `openjev_*` / forecast_ledger. |
| transcripts | **needs-change** | AV/Finnhub pulls portable; cadence ties to Model List plan (private) for tier-2. |
| option-history | **needs-change** | writes `optlab.*` (licensed/research — keep Mac); Polygon name source = plan/universe. |
| rbh-export | **private** | `~/rbh_scripts/*.csv`, holdings/orders. |
| rbh-ingest | **private** | all `portfolio_*` from RH CSVs. |
| option-scores | portable | `option_score_snapshots`, `option_chain_history` (tickers only). |
| model-snapshot | portable* | `model_recs`, option scores (*reads sanitized watchlist tickers; no qty). |
| model-grade | **needs-change** | grading `model_recs` = portable; must **not** run `resolveExpiredOptionTrades` / paper book path on VM. |
| regime | portable | intraday regime checkpoints / grades (no book). |
| ai-workflow-review | portable | `.cursor/context/ai-workflow-reviews/*`. |

\*Plus **not in INVENTORY_SPEC but in the chain:** `scripts/watchlist_sync/daily.py` → **private** (`portfolio_positions`, `portfolio_account_summaries`, `portfolio_ticker_earnings`, `portfolio_orders`, `portfolio_transactions`, RH watchlist JSON, LSEG, Schwab/RH quotes).

### LaunchAgents (`EXPECTED_LAUNCH_AGENTS`)

| label | tag | Notes |
|---|---|---|
| com.fildi.maintain | needs-change | Same as maintain row. |
| com.fildi.stack-ensure | portable | Boots local Postgres/API/Vite — Mac process manager; on a VM would be systemd equivalent (not this plist). |
| com.fildi.rbh-daily-export | private | rbh-ingest. |
| com.fildi.rbh-export-prompt | private | rbh-export. |
| com.fildi.pm-alerts | private | |
| com.fildi.transcripts | needs-change | |
| com.fildi.schwab-auth-watch | private | |
| com.fildi.openjev | private | |

Coverage check 2026-10-24: every `INVENTORY_SPEC` key + every `EXPECTED_LAUNCH_AGENTS` label tagged above.

---

## (b) Peak RSS (Mac, 2026-10-24)

| process | RSS | method / note |
|---|---|---|
| api-server (`tsx src/index.ts`) | **~528 MB** (540332 KB) | `ps -o rss=` while stack up 07:51 PT |
| Vite stock-compare | **~119 MB** | same |
| Postgres.app 16 | small per backend; cluster idle | |
| daily.py | *not re-run today* | Grok unmeasured estimate 0.45–0.8 GB remains; next trading morning: `/usr/bin/time -l .venv/bin/python daily.py --if-needed` + sampler. |
| monthly.py / lab-replay-technicals / transcripts / option-history | *deferred* | Capture on next scheduled fire; write numbers into this file. |

Command template for next measure:
```bash
/usr/bin/time -l python3 -c '...'  # or wrap the job
# sampler: while pgrep -f daily.py; do ps -o rss= -p $(pgrep -f daily.py); sleep 5; done
```

---

## (c) DB size by schema (excludes `lab_*` relation names)

| schema | size |
|---|---|
| optlab | 1116 MB |
| watchlist_sync | 241 MB |
| public | 142 MB |
| lseg_research | 102 MB |
| wrds_research | 81 MB |
| research_common | 0.3 MB |
| **Postgres** | **16.15** (Postgres.app), extension: plpgsql |

`portfolio_*` (private) ≈ 5 MB total. Sample PUBLIC tables subset ≈ 66 MB (not full allowlist).

---

## (d) Proposed one-shot entrypoints (portable jobs)

| job | proposed command (Linux host, public DB) |
|---|---|
| event-bullets | `cd artifacts/api-server && pnpm exec tsx src/scripts/run-morning-precompute.ts` (or dedicated bullets script) |
| earnings-backfill | same morning-precompute / existing earnings script |
| fmp-analyst-feed (FMP half) | morning-precompute with LSEG street-PT disabled |
| option-scores | `pnpm exec tsx src/scripts/snapshot-option-scores.ts` |
| model-snapshot | `pnpm exec tsx src/scripts/run-model-snapshot.ts` |
| model-grade (recs only) | scheduler path with trade-expiry book resolver **off** |
| regime | api-scheduler `FILDI_HOST_ROLE=public` (A241 P3) |
| ops-digest | `node scripts/…` digest-only (existing maintain flag) |
| maintain public half | `node scripts/maintain.mjs --public` (to build in A241) |

---

## (e) Never-receive list (public host must not get these)

**Files / secrets**
- `~/.fildi/private.md`
- Schwab token file
- Robinhood CSVs under `~/rbh_scripts/`
- Google Drive desk ingest folder
- LSEG / WRDS credentials; OpenJev weights if treated as local-only

**Tables / schemas (never copy)**  
All `portfolio_*` · `positions` · `user_portfolio_names` · `trade_posts` · `stock_holdings` · `likes` · `comments` · `feedback` · `invite_codes` · real `users`  
`watchlist_sync.{pm_book_latest, pm_alerts, forecast_ledger, rh_raw, lists, plans, plan_items, model_folders, model_runs, model_items, openjev_batches, openjev_runs, resource_snapshots}`  
`lseg_research.*` · `wrds_research.*` · `optlab.*` · `lab_*` · `watchlist_sync.{strategies, strategy_trades, strategy_equity, study_trades}`

**Allowlist for copy** = A241 PUBLIC + SANITIZED lists (tickers-only watchlist). Anything not listed = private by default.

**Diff vs A241 PRIVATE list (2026-10-24):** match — A211 never-receive ⊇ A241 PRIVATE; no A241 PRIVATE name missing here.

---

## Status
A211 stage 1 deliverables (a)(c)(d)(e) complete; (b) partial (api-server + vite measured; daily/monthly/lab/transcripts/option-history pending next fire). No scheduler code changed.
