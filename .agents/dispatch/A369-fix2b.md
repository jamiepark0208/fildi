A369 fix2b (Refs: A369). Shared study-contract harness. Scope = research/common/asks/A369.md line starting "**Claude add 2026-11-07 — fix2 scope" + review notes "Claude review 01f73dea" item 4.
Working dir: scripts/watchlist_sync. Python: .venv/bin/python. Cached names only (~/.fildi/cache/a359/); no LSE fetches.

Build ONE new file analysis/study_contract.py:
1. Cost model: stock = cross the spread; option = bid + FILL_SHARE (0.23) of spread. Import FILL_SHARE / tradable_net from analysis/cost_staging.py — do not re-define. Replace the fill/cost helpers in analysis/conditional_engine.py, analysis/fast_screen.py and the lab with imports from here. Leave archived one-off scripts untouched.
2. comparator(pnl, bp, dates) → per $ buying power, worst week, max drawdown, T-bill return for the same period (scripts/watchlist_sync/out/opt/dtb3.csv).
3. power_gate(n_deoverlapped, ci) → UNDERPOWERED if n < 30 or CI contains 0.
4. leak: call study_leak (fix1/fix2a) on every cell; keep NO-TIMING-EDGE when placebo_p > 0.10.
5. halves (first/second half of test) + SPY above/below 200d split.
6. packet() prints line 1 `CONTRACT 1-7: ok|missing <ids>` and calls sys.exit(2) when anything is missing or when a verdict uses mid-only fills.
Also (review 01f73dea item 4): shift test for hold_expiry / multi-session cells — the delayed entry carries across sessions (enter next session's first bar, then same exit rule), so shift coverage > 0 on those cells.

Smoke gate (run first; stop and report if any fails): fast_screen self-test still 11/11; packet() on a toy mid-only verdict exits 2; packet() on a complete toy cell exits 0.

Acceptance:
(a) S160 h5 gth 25 through the harness reproduces the current out/S160/result_h5_g25.json (± 0.05 pp);
(b) A359 fix4 21n top cell reproduces (± 0.5 bp net_fill);
(c) 21n top-5 hold_expiry cells: shift coverage > 0, shift_bp, placebo_p, verdict;
(d) grep shows no remaining local fill/cost function definitions in conditional_engine.py / fast_screen.py.

Packet (≤ 20 lines) appended to research/common/asks/A369.md under "## Cursor packet 2026-11-08 (fix2b)". Commit only the files above + A369.md, trailers Refs: A369, Agent: cursor.
