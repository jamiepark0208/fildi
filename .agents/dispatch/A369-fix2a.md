A369 fix2a (Refs: A369, A376, A378). Engine bugs only — the shared study_contract.py harness is fix2b, NOT this run.
Working dir: scripts/watchlist_sync. Python: .venv/bin/python. Use only cached names (~/.fildi/cache/a359/); no LSE fetches.

Fix exactly these (full text: research/common/asks/A376.md § Detail, A378.md § Detail, A369.md "Claude review 31a79507" notes 1–2):
1. A376 H1 — analysis/conditional_engine.py `_a359_cache_path` (~L1187): replace `abs(hash(key))` with hashlib.sha256 over tickers + a CACHE_VERSION string that includes the spread-calibration version, thresholds, exits, data max date. Write those into `*_meta.json` and refuse (rebuild) on mismatch.
2. A376 M1 — `run_threshold_sweep_from_cache` (~L1260+): use the cache path only for `same_day` exits; `tp50_overnight` / `hold_expiry` go through the legacy session-filtered path.
3. A376 M2 — analysis/study_leak.py `is_planted_lookahead` (~L55) + conditional_engine.py `run_conditional_leak_test` (~L1946): pair entry bar i with rets[i+1]; sign for short puts (edge = forward return not falling, i.e. compare short-put pnl, not long returns). Also fix `planted_lookahead_entry` default thr=0.0 vs raw prices (use an RSI threshold).
4. A378 — analysis/s160_rsi_per_stock.py (~L70–78): subtract train-era base `base_tr` for both eras. Re-run h5 and h10.
5. Fix1b note 1 — verdict: placebo_p > 0.10 → `NO-TIMING-EDGE` (separate from leak_flag, which stays shift-only).
6. Fix1b note 2 — delayed entry for a last-bar signal = next session's first bar (so shift coverage > 0 on hold_expiry late-bar cells).

Smoke gate (run first, stop and report if any fails): fast_screen.py self-test passes incl. planted-leak (flag True, correct sign) + random-signal (flag False); two separate `python -c` processes resolve the same cache path for the same key; changing CACHE_VERSION gives a different path.

Acceptance:
(a) cache hit on second run of a 2-name same_day sweep (print hit/miss);
(b) cached vs legacy agree on one same_day cell (± 0.5 bp) and an overnight cell now routes legacy;
(c) S160 h5/h10 before→after table (global RSI<25 excess, per-stock S−G, verdict) — say if any verdict changes;
(d) 21n top-5 cells re-printed: shift coverage, shift_bp, placebo_p, leak_flag, verdict (expect NO-TIMING-EDGE where placebo_p > 0.10).

Packet (≤ 20 lines) appended to research/common/asks/A369.md under "## Cursor packet 2026-11-08 (fix2a)": smoke results, (a)–(d), sha. Commit only the files above + A369.md with trailers Refs: A369, Agent: cursor.
