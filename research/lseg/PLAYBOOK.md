# LSEG Workspace batch playbook (USC student)

**Lane owner:** Claude Code · **Contract:** [`../LSEG_WRDS_SYNC.md`](../LSEG_WRDS_SYNC.md) · research-only, never `fund_score` / FIELD_DEFS / hot path.

## Prereqs
1. Refinitiv/LSEG Workspace app (`/Applications/Refinitiv Workspace.app`) **running and logged in**. The API proxy listens on `127.0.0.1` at the port in `~/Library/Application Support/Data API Proxy/.portInUse` (usually **9000 or 9001** — do not assume 9000 alone).
2. `LSEG_APP_KEY=…` in repo-root `.env.local` (Workspace search → `APPKEY` → tick *Eikon Data API* only).
3. Venv: `python3 -m venv .venv && .venv/bin/pip install -r requirements.txt`

## Workflows (manual CLI only, run from `research/lseg/`)

| Order | Command | Writes | TTL / skip |
|---|---|---|---|
| 0 | `.venv/bin/python coverage.py` | `lseg_research.coverage`: held → traded (180d, recency-weighted) → watchlist → lookalikes of your traded names → book | rebuild weekly or after big portfolio changes |
| 1 | `.venv/bin/python sync_ids.py` | `research_common.security_map` ric/cusip/isin (COALESCE, never WRDS cols) | 30d |
| 2 | `.venv/bin/python sync_signals.py` | `lseg_research.signals_daily` (one row / ticker / day) | skips tickers already done today |
| 3 | `.venv/bin/python sync_events.py` | `lseg_research.events` (60d) + `research/common/out/earnings_watch.json` (14d earnings, loop C) | none, idempotent |
| 4 | `.venv/bin/python sync_earnings_moves.py` | `lseg_research.earnings_moves` (past earnings reactions, timing-aware) | 7d |
| 5 | `.venv/bin/python sync_holders.py` | `lseg_research.holders_top` (top-10 holders, adding/trimming, block holders) | 7d |
| — | `.venv/bin/python sync_starmine_history.py` | `lseg_research.starmine_history` (monthly, 2019→) | 28d, incremental |
| — | `.venv/bin/python sync_daily_history.py` | `lseg_research.daily_history` (close + ATM IV 30/60d, 2020→): batched, resumable, split-aware | daily top-up (≈30 requests); `--force --start` for deep pulls (watch the monthly datapoint guard) |
| — | `.venv/bin/python lseg_check.py` | nothing (entitlement probe) | — |

Default universe = **`lseg_research.coverage`** (built by `coverage.py` from your holdings, Robinhood order history, watchlist, and IV/vol/beta/size/peer-group lookalikes of what you trade) ∪ shared book, cap **150**. Falls back to holdings ∪ book if coverage hasn't been built. `earnings_watch.json` → WRDS stays ≤50 (priority order).
Flags: `--tickers A,B` (override), `--universe book|registry`, `--no-holdings`, `--force`.
Every run logs to `lseg_research.pull_log` + `sync_state` (same shape as `wrds_research.*`).

## Gotchas learned 2026-10-04
- **Relative dates are trading days.** `SDate=-30D` ≈ 30 *trading* days back. Use explicit ISO dates for calendar windows. This bug once made CRM's 30d EPS drift read +18.5% instead of +0.4%.
- **`get_history` needs `end=`.** With only `start=` it silently returns the last 20 rows.
- **Past earnings dates:** use `TR.EPSActReportDate` (Period=FQ0, Frq=FQ; includes report time). The events feed caps rows per request and dividend rows from foreign listings crowd out earnings.
- **Loss-makers flip signs.** Use `(a−b)/|b|` for % change, never `a/b−1` (OKLO −0.89 → −0.95 must read −6.9%). LSEG's Predicted Surprise already uses this convention.
- **FY1 rolls over.** 30d drift is nulled when FY1 period end differs between the two readings (e.g. COST after its 8/31 FYE).
- **Display names collide** (two "Earnings Per Share - Mean" columns), so read `get_data` results by position, not by name.
- **Foreign issuers on US venues** (POET: CA ISIN, NASDAQ) are accepted via exchange name.
- **Symbol conversion can return expired RICs** (`BFb.B^J07`) or foreign listings (`BRK.B` → Indian DR). `sync_ids.py` requires a US ISIN, no `^`, and a matching ticker symbol, then falls back to class-share RICs (`BRKb.N`).
- **Events feed is noisy.** ExDividends/StockSplits rows come from foreign depositary listings, and Conferences under JPM are JPMorgan-hosted. `sync_events.py` keeps issuer-level types only.
- **No history for ARM or Value-Momentum** (current value only). Predicted Surprise + Combined Alpha have monthly history back to 2019.
- **Not entitled:** `.MERH0A0` (ICE BofA HY), `USCDSHY5Y=MP`. TSLA/XOM have no primary CDS RIC.

## Gotchas learned 2026-10-05
- **Budget = requests/day AND datapoints/month.** `_session.lseg_session` refuses to start at 80% of either (`lseg_research.usage_daily`). A full 10-year IV pull for 256 names ≈ 4M points: request only needed fields.
- **History is on today's share basis.** After a split, stored closes are on the old basis: `sync_daily_history` re-reads 5 overlap days each run and re-fetches the ticker on any mismatch.
- **Some RICs have no TS.Interday history** (AVB.N / EQR.N, error 70005) but do have `TR.PriceClose` with `SDate/EDate/Frq=D`; it repeats the last value on non-trading days (dedupe by date). Check `TR.InstrumentIsActive`: AVB is acquired (inactive since 2026-08-14), not stale.
- **Watermarks per ticker, not per dataset**, or newly covered names never backfill; `db.recently_empty` stops re-requesting names the vendor has nothing for.

## Routine (Workspace open)
- **Weekly:** `coverage.py` → `sync_ids.py` → `sync_earnings_moves.py` → `sync_holders.py` → `sync_starmine_history.py`
- **Daily:** run by `scripts/watchlist_sync/daily.py` (signals → daily_history → StarMine/earnings if due), inside the Robinhood export session (COLLECT_PROTOCOL Steps 13–14); `sync_events.py` as before
- Earnings-premium verdict (rich/fair/cheap) only appears when the report falls before Fildi's nearest IV expiry (≈ earnings week). Further out the panel shows the stock's typical earnings move instead. See `stock-compare/src/lib/lseg-earnings.ts`.
