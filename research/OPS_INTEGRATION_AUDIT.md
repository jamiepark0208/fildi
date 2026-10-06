# LSEG + WRDS — Operations Integration Audit (Settings tabs)

**Date:** 2026-10-04 · **Author:** Claude Code (LSEG lane) · **Status:** LSEG metering/audit/purge shipped; **Cursor ops asks 1–6 done** (2026-10-04 evening)
**Companion to:** [`LSEG_WRDS_SYNC.md`](LSEG_WRDS_SYNC.md) (lane contract). Nothing here changes the contract's "research data never overwrites gold / FIELD_DEFS" rule.

## Bottom line

LSEG and WRDS are **integrated into the product surfaces** (Breakdown panels, Street Radar, fund growth extras for IBES, options earnings risk). Ops integration:
- **API Monitor:** `SOURCE_META` + `PRIMARY_SOURCES` include `lseg` / `wrds`; Research caches block from `/api/research/ops`. LSEG writes `api_usage` (Claude); WRDS `MeteredWrds.raw_sql` writes `api_usage` (Cursor).
- **Scheduled Tasks:** Research Ops Health (probe) + supervised LSEG daily/weekly + WRDS monthly IBES / quarterly CRSP.
- **Stock DB:** Vendor cross-check panel → `/api/research/lseg/audit` + Queue refetch.
- **License deletion:** LSEG `purge.py` (Claude) + WRDS `purge.py` (Cursor).

## Tab-by-tab

| Tab | What it does today | LSEG | WRDS | Needed? | Action | Owner | Status |
|---|---|---|---|---|---|---|---|
| **API Monitor** | Daily calls per source from `api_usage`; `SOURCE_META` limits + progress bars; data-health (gold freshness, bronze rows) | ✅ `api_usage` source=`lseg` | ✅ `MeteredWrds` → `api_usage` | **Yes** | SOURCE_META + PRIMARY_SOURCES + Research caches block shipped. | UI: Cursor · WRDS metering: Cursor · LSEG metering: Claude | ✅ |
| **Scheduled Tasks** | Registry of launchd + api-scheduler + **supervised** tasks with status/logs/run | `research-ops-health` + supervised daily/weekly | supervised monthly IBES / quarterly CRSP | **Yes** | Supervised entries from `sync_state` ages + CLI commands in detail. No vendor cron. | Cursor (scheduled-tasks.ts) | ✅ |
| **Stock DB** | Gold fundamentals + provenance (`field_provenance`), divergent fields, overrides, refetch queue (`fetch_queue`), enrichment runs | Not in FIELD_DEFS (correct, by contract). **`lseg_research.gold_audit`** + `GET /api/research/lseg/audit` (admin) | FinRatios audit planned (W4), not wired | **Yes, as auditor only** | Vendor cross-check panel + Queue refetch shipped. WRDS FinRatios later. | UI: Cursor · data: Claude ✅ | Data ✅ · UI ✅ |
| **Cache Monitor** | In-process caches from `cache-registry` (TTL edit / clear) | Not a cache: routes read Postgres directly | Same | **No** | Measured: `/research/lseg/radar` 2–9 ms, `/research/lseg/:ticker` 1–6 ms. The "cache" *is* the `*_research` tables, refreshed by CLI syncs. Adding an in-memory layer would only add staleness. **Freshness belongs in Research Ops / API Monitor, not here.** Optional: a read-only "Research tables" row listing `sync_state.last_ok_at` per dataset. | — | Not needed |
| **Sector Peers** | Peer groups (`peer_groups`, overrides) | `coverage.py` *reads* peer groups for lookalikes | — | Optional | LSEG has TRBC industry codes; could audit peer membership (flag tickers whose TRBC industry disagrees with their peer group). Low priority. | Claude (later) | Backlog |
| **Scorecard Guide** | Explains scoring | soft only | **IBES `ibesRevBreadth` + `ibesSue` feed fund growth** | **Yes** | Documented in FundamentalTreatmentPanel + ENGINE_METRICS. | Cursor | ✅ |
| Profile / User Mgmt / Feedback | Account admin | — | — | No | — | — | — |

## Cross-cutting

| Concern | LSEG (now) | WRDS (now) | Gap / action |
|---|---|---|---|
| **Budget** | ✅ `MeteredLD`: counts requests + approx datapoints → `api_usage`; **refuses to start a run at ≥80% of 10,000 req/day**; throttles to ≤4 req/s (LSEG limit is 5/s shared with Excel/Workspace). Typical full refresh: ~150 requests/day. | Self-imposed (≤50 tickers, TTL 28d/90d, one job at a time) but **not counted** | WRDS: record queries in `api_usage`. |
| **Errors** | ✅ Transient errors (429/timeout/5xx) retried ×2 with backoff; field/entitlement errors fail fast. Clear message when Workspace isn't running or logged in. Every run writes `pull_log` (ok/partial/error). | `_auth.connect` retry ×3; `pull_log` (2 errors so far) | `research-ops.ts` should surface the **latest `pull_log` error text**, not only staleness. A sync failure leaves the previous snapshot in place, so the app keeps serving last-good data (graceful). |
| **Staleness thresholds** (`research-ops.ts` `STALE_MS`) | Covers signals_daily, events, security_map_ids, starmine_history | Covers IBES/CRSP | **Add:** `earnings_moves` 8d, `holders_top` 8d, `coverage` 8d, `gold_audit` 8d. **Fix:** `security_map_ids` 14d → 35d (sync TTL is 30d, so 14d would show false "stale"). |
| **Retention** | Small: signals_daily ~110 rows/day (~40k/yr), holders 1.1k/week | Bounded by watermarks | Optional: keep 400d of `signals_daily`/`holders_top` in `lib/retention.ts`. Not urgent. |
| **License deletion** | ✅ `research/lseg/purge.py --dry-run / --confirm` (drops `lseg_research`, blanks LSEG cols on `security_map`, removes hand-off file + `api_usage` rows). App degrades to `available:false`. | ❌ none | WRDS: equivalent `purge.py` (contract §3.1). |
| **Earnings dates (shared truth)** | LSEG events vs app `earnings_calendar`: 7 conflicts >3d | — | Proposed shared `research_common.earnings_dates` (earliest-date rule + conflict flag); `/api/research/lseg/signals` already applies earliest-date. |

## Shipped by Claude in this pass (LSEG lane only)
- `research/lseg/_session.py`: `MeteredLD` (throttle, retry, count) + `api_usage` source `lseg` + 80% daily budget guard + clear Workspace-not-running errors.
- `research/lseg/audit_gold.py` → `lseg_research.gold_audit`; `GET /api/research/lseg/audit` (requireAdmin).
- `research/lseg/purge.py` (license deletion).
- `coverage.py` now records `sync_state` / `pull_log` (it was invisible to health checks).

## Asks for Cursor (no file overlap with LSEG lane)
1. ✅ API Monitor `SOURCE_META` + `PRIMARY_SOURCES` for `lseg` / `wrds`; WRDS `api_usage` metering (`MeteredWrds` + Research caches block).
2. ✅ Scheduled Tasks: supervised `lseg-daily-sync`, `lseg-weekly-sync`, `wrds-monthly-ibes`, `wrds-quarterly-crsp`.
3. ✅ Stock DB: "Vendor cross-check" panel → `/api/research/lseg/audit` + Queue refetch (WRDS FinRatios later).
4. ✅ `research-ops.ts`: `earnings_moves` / `holders_top` / `coverage` / `gold_audit` @ 8d; `security_map_ids` 35d; `lastError` from `pull_log`.
5. ✅ Scorecard Guide: IBES growth extras callout + ENGINE_METRICS rows.
6. ✅ WRDS `research/wrds/purge.py` (`--dry-run` / `--confirm`).
