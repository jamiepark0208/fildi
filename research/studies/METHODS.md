# Method rules (lessons that cost us a study to learn)
> Apply all of these before trusting a result. Each line names the study that taught it.

## Targets and confounds
1. **Never grade put/call factors on raw return.** An unexpired option returns premium ÷ strike, so high-IV names "win" by construction
   (fake ICs of 0.4–0.7 in S005; StarMine looked t −15 in S003). Use premium kept (P&L ÷ premium), stock vs strike after assignment,
   or return vs sector peers.
1b. **Grade a feature on the decision it feeds, not on stock direction** (Jamie 10-18, S045). Before a FAIL, test it on every
   use it could have: put selection (weekly 1σ-IV put pnl + breach, `analysis/s045_put_retest.py`), strike placement, sizing
   (pnl variance, not mean), avoid list (left tail). S042 graded the tech score on 21d return → "≈ 0"; on puts it sorted
   +15.7 bp/wk. A FAIL row must list which uses were tested.
2. **Hold IV fixed** (partial IC or IV-neutral buckets) for any option factor; then run a placebo (shuffled factor IC ≈ 0). S004.
3. **Volatility mechanics:** raw % drops and trailing-vol scaling both produce fake signals; normalize drawdowns by implied σ. S004.
4. **Redundancy:** test a new factor with trend held fixed; many "signals" are price momentum again (PT revisions ρ 0.77, S009).
5. **Baseline by construction:** compare against the same strike distance / delta on random days for the same ticker (S011), or a
   one-feature baseline (S004 criterion 5), not against zero.

## Sample and significance
6. Pass marks (S004): IC > 0 with |Newey-West t| ≥ 2, hit > 55%, monotonic quintiles, same sign in both halves and in selloff vs normal.
   With ~40 tests, expect ~2 at |t| ≥ 2 by luck: treat |t| ≥ 3 as the bar for a new score input (Harvey-Liu-Zhu, S009).
7. **Cluster** trades that share a week and ticker before computing a CI (bootstrap by (ticker, week)). S011.
8. **Pre-register** the question, target and stop rule (add the row to INDEX "Next studies" first); a failed stop rule ends the study (S006).
9. Live claims need ≥ 8 distinct expiries and ≥ 100 trades (tilt rule, `TILT_MIN_EXPIRIES`).

## Data
10. **Survivorship:** our ticker list is today's survivors. Bias ≈ 0 at ≥ $3 / ≥ $300M, ~+0.1 pt/mo in high-vol small caps (S010).
11. **Fills:** Robinhood realistic fill = bid + ~23% of the spread (10–36%); Fildi chain premium = bid. Backtests use BS at IV × 0.85 fill. S012.
12. **Reconstructed options** (BS at LSEG ATM IV, no skew) are not chain history; contract-level parts (buffer, DTE, liquidity) need
    `option_chain_history` (accruing since 2026-10-06) or the live ledger.
13. Point-in-time only: fundamentals before filing dates and percentile inputs over a growing bar window both leak (S004 #7).
14. Robinhood exports sometimes drop Avg Cost / avg premium / delta (2026-10-06); `wheel.py` carries cost from the prior snapshot.

## Tooling
15. Python 3.14 pandas datetime ops segfault in `research/wrds/.venv` → use csv/gzip (S010).
16. psycopg: escape `%` as `%%` in LIKE patterns.
17. Outputs: markdown → `out/<study>/report.md` (versioned); caches/data (`.csv.gz`, `.npz`, `.pkl`, `.json`) stay local.

## Decisions
18. A study changes scoring or which ideas are shown only with the user's approval and a before/after (AGENTS.md rule 5).
    Display-only tags and warnings are fine without it.
