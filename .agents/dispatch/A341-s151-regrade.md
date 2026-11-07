A341 P4 — re-grade S151 Phase 4 (our only quant PASS) under AFML gates. Study only, no live/score change. Agent: cursor, Refs: A341.

Code (exact paths, no searching):
- scripts/watchlist_sync/analysis/s151_phase4_excess.py — monthly_excess_series(), month_block_t(), metrics_for(), run_window_fixed(), apply_bh_and_best(). This produced S151 P4 (out: research/studies/out/opt/S151.md).
- scripts/watchlist_sync/analysis/fast_screen.py — deflated_sharpe(xs, n_trials) line 522, pbo_cscv(perf_matrix) line 548. Reuse, do not rewrite.
New script: scripts/watchlist_sync/analysis/s151_regrade.py (imports both).

What to compute
1. Trial count N = every signal × instrument × tier × window cell S151 P4 evaluated (the full grid before BH, not just survivors). Print N and how it was counted.
2. For the 2 passing sell-put signals (0.08Δ next-open after high-volume up day + SPY RSI-14 bottom quintile; + IV÷RV bottom quintile), both windows (2023–26, 2018–22):
   a. Monthly excess series (signal put P&L − base put P&L, per month, n = months) via monthly_excess_series. DSR = deflated_sharpe(series, N).
   b. PBO = pbo_cscv on the cell × month matrix of ALL N cells' monthly excess (CSCV-16).
   c. Purged K-fold: k=5 contiguous month folds, 1-month embargo each side; per fold report breach rate signal vs base and excess sign.
3. Placebo: shuffle signal dates within ticker-month, 20 seeds → report how many reach DSR ≥ 0.95 (gate must reject ≥ 19/20).

Pass bar per signal (pre-registered): survives = DSR ≥ 0.95 AND PBO < 0.5 AND same-sign excess in ≥ 4/5 purged folds in BOTH windows. Else downgraded (say which gate failed). If n months < 24 in a window, say "underpowered" — not FAIL.

Outputs
- research/studies/out/opt/S151-regrade.md (table: signal × window × N, DSR, PBO, folds same-sign, old verdict, new verdict; placebo line).
- Append to research/common/asks/A341.md under ## Reviews: "**Cursor packet <sha> (S151 re-grade):**" ≤ 20 lines, best cell first.
- research/studies/INDEX.md S151 row: append " · AFML re-grade 11-06: <survives|downgraded> (DSR x, PBO y)" via Edit, not a rewrite.
- Runtime target < 10 min. Commit only your files, trailer Refs: A341 / Agent: cursor, then scripts/agent-git-sync.sh.
