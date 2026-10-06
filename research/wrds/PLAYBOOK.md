# WRDS batch playbook (USC academic)

**Status:** discovery done · pulls proven · research-DB sync allowed · **never** live `fund_score` / hot-path.

## Hard constraints (license + ops)

| Rule | Why |
|---|---|
| **Academic / non-commercial research only** | WRDS ToU — no commercial product features powered by vendor data |
| **No live scoring / no FIELD_DEFS merge** | Keep out of `ticker_fundamentals` gold; research schema only |
| **No scheduler / LaunchAgent cron** | Manual or rare quarterly/monthly CLI; student accounts also have semester-break lockouts |
| **One WRDS job at a time** | WRDS simultaneous-request limit (web); be polite on Postgres too |
| **Narrow SQL — ticker list + date watermark** | Avoid full-table scans (`tr_ibes.statsumu_*` is ~15M rows) |
| **Persist once → re-read local** | Postgres `wrds_research.*` is the cache; parquet is optional export |
| **Delete when affiliation ends** | WRDS download policy — secure, private, not shared centrally |
| **No OptionMetrics / no TAQ dumps** | Not subscribed (OM) / too heavy for no product need (TAQ) |

Budget (self-imposed, not WRDS billing — academic access is session-limited, not $/call):

| Dataset | Cadence | Max tickers / run | Window |
|---|---|---|---|
| IBES statsum + surpsum | **Monthly** (or on earnings-watch research) | ≤50 (default book / registry slice) | watermark → today; first backfill ≤730d |
| CRSP dsf | **Quarterly** (data lags ~year-end) | ≤50 | from last `date` watermark → max available |
| Compustat / FinRatios | **Only if** gold fund metrics disagree (outlier research) | ≤20 | latest FY/FQ only |
| 13F / Insiders | **Quarterly** research overlay | ≤50 | latest filing vintage |
| TRACE / BoardEx / Audit / RavenPack trial | **Off by default** | — | ad-hoc only with written need |
| TAQ / TAQm / OptionMetrics sample | **Forbidden** in workflows | — | — |

## Top features researched (how WRDS is actually valuable here)

Ranked by **unique value vs what TradeDash already has** (Yahoo/FMP/FactSet/Schwab):

| Rank | Feature | WRDS product | Why it is (or isn’t) a value-add |
|---|---|---|---|
| **1** | **IBES consensus revisions + surprises** | `tr_ibes` (`statsumu_epsus`, `surpsum`, `actu_*`) | True gap: Yahoo `earningsTrend` is thin; FMP PT burn is discouraged. Revision/surprise history is the #1 research prior for earnings windows. |
| **2** | **CRSP clean returns (delisting-aware)** | `crsp` / `crsp_a_stock` + CCM | Event-study calibration of move windows; not a live price feed (Schwab/Yahoo win there). Data currently lags through **2024-12-31**. |
| **3** | **WRDS Financial Ratios (+ IBES)** | `wrdsapps_finratio*` | Prebuilt ratio panel to **audit** gold fund metrics — not replace FMP/FactSet. |
| **4** | **Compustat NA (segments / PIT-ish)** | `comp_na_daily_all`, segments | Peer/segment research when FactSet/FMP disagree — surgical, not full dump. |
| **5** | **13F institutional holdings** | `tr_13f` | Ownership concentration research; lagged; optional quarterly. |
| **6** | **Insiders** | `tr_insiders` | Form-4 style flow research; Yahoo already has some insider modules. |
| **7** | **Event Study apps** | `wrdsapps_evtstudy_*` | One-shot calibration of CAR windows — not a standing pipeline. |
| — | TRACE credit tape | `trace_*` | Niche unless credit desk feature; off by default. |
| — | RavenPack trial | `ravenpack_trial` | Trial limits; Daily News already digs TipRanks/web — don’t burn trial. |
| — | BoardEx / Audit | `boardex_na`, `audit_*` | Governance/restatement research only. |
| **Skip** | OptionMetrics / Options Suite | unsubscribed | Keep IV on Schwab/Yahoo snapshots. |
| **Skip** | TAQ millisecond | heavy | No microstructure product need. |
| **Skip** | FactSet-on-WRDS | samples only | You already have Marshall FactSet API. |

Sources: USC My Datasets subscription dump · `.cursor/tasks/research/data-source-integration-070926.md` (T2 quarterly bronze) · live `inventory.py` (280 libs).

## Shared with LSEG

Contract: `research/LSEG_WRDS_SYNC.md`. Universe SoT: `research/common/universe_book.txt`.
WRDS owns history; LSEG owns now/forward. Never double-pull IBES history.

## Score path (why we pull)

IBES → `wrds_research` → `ibesRevBreadth` / `ibesSue` → fund **growth** → `fund_total_score` → options **stockQuality** (puts and calls).  
UI: Breakdown “Street · puts/calls (WRDS)” explains verdict; tech oversold/overbought stays the timing gate for directional views.

## Allowed workflows (only these)

### A. IBES revision sync (primary)
```bash
cd research/wrds && source .venv/bin/activate
python sync_ibes.py --universe book   # or --tickers NVDA,MSFT
```
- Reads `wrds_research.sync_state` watermark (`statpers`)
- Skips if last successful pull < 28 days (override `--force`)
- Upserts into `wrds_research.ibes_statsum` / `ibes_surpsum`
- Logs row counts in `wrds_research.pull_log`

### B. CRSP returns sync (secondary)
```bash
python sync_crsp.py --universe book
```
- Anchors to `MAX(date)` available (handles CRSP lag)
- Upserts `wrds_research.crsp_dsf`
- Quarterly default TTL 90d

### C. Inventory (rare)
```bash
python inventory.py   # only after subscription changes
```

### D. ID map (W1) — run after LSEG sync_ids
```bash
python fill_security_map_wrds.py          # all security_map rows
# GOOGL and GOOG are separate classes — ticker-first match, not CUSIP collapse
```

### E. Loop C — earnings-watch force IBES
```bash
python sync_ibes.py --universe coverage --earnings-watch
```

### F. Loop A — consensus reconcile
```bash
python reconcile_consensus.py --universe coverage
# → research/common/out/reconcile_consensus.json
```

### G. Calibration + event windows (offline)
```bash
python calibrate_starmine.py --universe book
python event_windows.py --universe book
python sync_finratio.py --universe book   # ≤20 audit ratios
```

### Explicitly not built
- Nightly enrich hook · API route that hits WRDS · merge into `ticker_fundamentals` · OptionMetrics · full Compustat history · TAQ

## Persistence model

```
WRDS Postgres  --(narrow SQL)-->  research/wrds sync_*  -->  local Postgres schema wrds_research
                                      │
                                      ├─ sync_state (dataset, watermark, last_ok_at, rows)
                                      ├─ pull_log   (audit)
                                      ├─ ibes_statsum / ibes_surpsum
                                      └─ crsp_dsf
```

Consumers: **offline notebooks / calibration scripts only.** UI may later show research chips only if license review says OK — default is no UI.

## Apply schema once

```bash
psql "$DATABASE_URL" -f research/wrds/schema.sql
```
