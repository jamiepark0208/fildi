A192 Part D2 (Refs: A192). Spec = research/common/asks/A192.md section "Claude 2026-11-08 — S166 teardown" → "### Part D2". Read that section first; do not re-derive.
Working dir: scripts/watchlist_sync. Python: .venv/bin/python. No new vendor fetches (DB + ~/.fildi/cache only).

Build analysis/s167_spreads_on_edge.py:
1. Entries (weekly, point-in-time): S100 "rising revisions + strong 60d" top group from analysis/s100_factor_pairs.py `long_study` (reuse its event frame; import, don't copy) and S046 calls lane (low volume + not stretched above 200d) from analysis/s046_calls_avoid.py `build`. Tag each entry with its source.
2. On the SAME entry rows compare: (a) Δ-matched stock, (b) long ATM call priced with the S081 stack (analysis/s081_long_options.py `build` pricing: BS at iv30 × S075 ratio, fill bid+23 %), (c) bull call debit via analysis/structure_vec_engine.py `price_paths_from_legs` with strike pairs: long 0.50Δ or 0.65Δ × short at +0.5σ or +1σ; DTE 30 / 45.
3. Exits for (b)(c): hold-to-expiry · TP 75 % of width · TP 90 % of width · close at 7 DTE. NO price stop.
4. Grade: return per $ at risk (debit; stock = Δ·S notional) per day; train 2021–23 / test 2024→; month-clustered t; placebo = random days in the same months (study_leak.py); T-bill comparator from out/opt/dtb3.csv.
5. Teardown table per cell: share of trades by ex-post move bucket (σ: <−0.5, −0.5–0, 0–0.5, 0.5–1.5, >1.5) with spread vs call vs stock in each.

Smoke gate (stop and report if it fails): 3 tickers; hand-check one bull call debit (strikes, debit ≤ width, expiry payoff) and one long call; entry counts per source > 0 in both eras.
Pre-registered pass: a spread cell beats BOTH stock and long call on test, month-t ≥ 2, placebo_p ≤ 0.10. Stop rule: every train cell trails stock → report and stop (no test peeking).

Write out/opt/S167.md + packet (≤ 20 lines) appended to research/common/asks/A192.md under "## Cursor packet (Part D2)": smoke, per-source n, best train cell, its test vs stock vs call (t, placebo_p), move-bucket table for the best cell, verdict. Commit only s167_spreads_on_edge.py, out/opt/S167.md, A192.md — trailers Refs: A192, Agent: cursor.
