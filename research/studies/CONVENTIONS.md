# Timestamp & entry conventions (A131)

Every study/backtest declares how it aligns events to tradable times. **Printed date ≠ first tradable session** for AMC news/earnings.

## House rules
1. **Earnings:** AMC report date → first tradeable session = next regular session; BMO → same calendar session. Prefer LSEG true report dates (A114); never fiscal period ends.
2. **Daily signals:** if a factor uses day-t close, entry P&L starts at **next** close (or next open) — never same-close fill unless the study explicitly says "close-to-close descriptive only".
3. **Macro revised series:** NFCI / payrolls / similar → ALFRED vintages when available; else disclose revision risk.
4. **News/transcripts:** use `received_at` / first-seen, not headline print date, before any news study.
5. **INDEX row:** add `timestamp convention: <one line>` when filing or re-running a study.

## Path inventory (Cursor 2026-10-16)

| Path | Role | Classification | Notes |
|---|---|---|---|
| `analysis/backtest_puts.py` (S003) | Flagship put factors | **unknown → audit** | Entry on reconstructed option day; verify no same-close peek on factor build |
| `analysis/trade_mistakes.py` (S015) | RH puts + earnings | **clean** (post A114 re-run) | True earnings dates; AMC/BMO handling claimed in report — spot-check sample |
| `analysis/s018_earnings.py` | Earnings move vs straddle | **clean** | Pre-close straddle vs first close after report |
| `analysis/s025_reversals.py` | Drop → forward return | **leaky risk** | Signal from closes through day t; outcomes are forward from that close — **same-close** convention; re-run with t+1 entry per Claude plan |
| `analysis/s026_calendar.py` | Event weeks | **clean-ish** | Week flags; weekday uses next-5d from that close (disclosed) |
| `analysis/s027_regimes.py` | Regime × puts | **unknown** | Regime from daily closes; put entry alignment TBD |
| `analysis/s028_*.py` / S028 report | Macro stress | **disclosed leaky** | NFCI revisions noted in study |
| `analysis/s029_recession.py` | Recession odds | **clean** | Expanding window; labels lag 12m |
| `analysis/s024_sector_weights.py` | Fund weights PIT | **clean** (claimed weekly PIT) | Spot-check 10 rows vs as-of |
| `scripts/watchlist_sync/transcripts.py` | Earnings transcripts | **unknown** | AV quarter label; not used as trade timestamp yet |
| Daily News / digFacts | News briefs | **unknown** | Must use `received_at` before any event study |

## Next (Cursor)
1. Confirm S025/S027/S030 same-close entry; patch scripts or re-run with t+1 and report Δ.
2. Add `timestamp convention:` one-liner to each INDEX row as studies are touched.
3. Claude [quant] signs off before trusting any new A120 discovery.
