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
Speed (fix3b frontier took 40 min: 20 cells × ~150 s, each reloading bars + recomputing): load bars + indicators ONCE per ticker, sweep all thresholds/universes in memory from that pass (multiprocessing over tickers if needed). Target: full threshold × exit frontier ≤ 5 min. Report wall time before → after in the packet.
Sanity check on the after-run: results MUST vary with threshold (fix3b showed net −26 bp / win 34 % flat across RSI 5…25 = trigger degenerate). Flat again → H1 not fixed.

## Smoke gate (before the full run; stop and report if any fails)
Slice: SPY + QQQ + 3 names, last 20 sessions (≤ 2 min).
1. RSI14 is NaN for the first 13 bars of the series and never NaN after warm-up; first-bar-of-session RSI equals prior-session continuation (print 3 examples).
2. Trade count differs between RSI<10 and RSI<30 (print both counts); identical → H1 not fixed, stop.
3. One trade hand-checked: entry = next bar open, IV rises on a down path (print iv_anchor → iv_exit with spot move).
4. Carried trade: print one overnight trade's exit bar (must be 0 when the open breaches).
