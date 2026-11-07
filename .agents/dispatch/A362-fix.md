# A362 fix — A359 conditional engine correctness (Cursor, after A359 fix3b)
Read: research/common/asks/A362.md (findings + § Claude plan 2026-11-07). File: scripts/watchlist_sync/analysis/conditional_engine.py; tests: a359_conditional_test.py. Python: scripts/watchlist_sync/.venv/bin/python.
Do, in order:
1. H1 rsi_series: callers pass the continuous close series (prior sessions as warm-up), `min_periods=n`; slice per session. Applies to simulate_session_puts (L~425), condition_true_series, exits.
2. H2 iv_intraday_path: `exp(beta*lr)` (β from load_iv_return_betas is Cov(lr,ΔlogIV)/Var).
3. H3 carried positions: start exit checks at bar 0 of the new session.
4. M4 n_eff = distinct (session, sector) clusters.
5. M1 exits fill next bar open; M2 TP/SL on h/l with gap-through at open price; M5 no entry on last 2 bars; M6 base runs every session incl. carry sessions, re-entry allowed after carry closes; M3 headline net_cross, net_mid second.
6. Catalog: drop indicators condition_true_series can't compute.
Tests (assertive): one fire per edge (len==1), RSI NaN before n bars, IV rises on down move, carried exit at bar 0, n_eff==1 for 10 trades/1 cluster, fill price uses o when o≠c.
Then run `fast_screen.py conditional --survivor-tail` (jamie-smoke + full) BEFORE and AFTER; packet ≤ 20 lines in A362.md: n, win, mean net_cross, lift vs base per cell, before→after. Commit `Refs: A362`, `Agent: cursor`. Pass = all tests green + table.
