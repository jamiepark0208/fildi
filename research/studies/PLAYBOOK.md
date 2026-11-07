# Backtest playbook — how to answer "does X help Jamie's trades?" (all agents)

> Claude 2026-10-18, from S041–S045. Rules = `METHODS.md`; this is the hands-on how. Read `INDEX.md` first (maybe it's answered).

## 0. Screen first, study second (A341, Jamie 11-06 "studies too slow")
> **Gate before any edge claim (Jamie 11-06):** `.agents/skills/fildi-quant-research/trade-decision-protocol.md` Module A (A1–A9: condition fires, N_eff, same-ticker lift, neighbourhood, era split, conditional entry + exits). Deficiencies D-1…D-10 listed there.
Any "does strategy/signal X work?" starts in the fast screen (S157) — seconds, not hours. Full study only for what it flags.
1. Add the signal as one vectorized fn (≤ 15 lines) in `scripts/watchlist_sync/analysis/screen_signals.py` (one home; live shadow signals import it too) + a library row in `analysis/fast_screen.py`.
2. `cd scripts/watchlist_sync && .venv/bin/python analysis/fast_screen.py self-test` then `run` (68 cells ≈ 11 s, plus the use-case grid unless `--skip-usecases`: 1,030 variants ≈ 28 s — settings grids, put-breach job, raw vs matched lenses, SPY-regime/IV/sector splits), then `puts` (same-delta short-put P&L vs peers + T-bill, 2×2 vs the live put score).
3. Gate is built in: comparator = **same-day, same 20d-vol-decile peers** (leave-one-out); t, deflated Sharpe and PBO on **monthly excess**; placebo must give 0 survivors ≥ 19/20.
4. Report "best version + its job" (stock entry / put timing / avoid / sizing), never a drop list. Put use found → shadow challenger in `strategy_signals.py` + chip, promotion trigger pre-registered (A341 decision block); the agent decides the score change (AGENTS 7).
5. Needs minute bars, option marks beyond the trade pool, or Δ outside 0.08–0.20 → that's when a full study (§ 1–5) is worth it.

## 1. Start from the decision, not the stock
Jamie earns by **selling weekly puts (and covered calls)** and sorting names into Model List folders. Grade a feature on the
decision it feeds (METHODS 1b):
| Decision | Target | Where |
|---|---|---|
| Which names to sell puts on | weekly 1σ-IV put pnl per $ collateral + breach (S_T < K) | `s045_put_retest.py` |
| Strike placement | breach at fixed IV distance (e.g. volume node between K and S) | S045 `sr_cushion` |
| Position size | weekly pnl **variance / tail**, not mean | S045 regime sizing |
| Avoid list | left tail: 5d drop ≥ 2σ IV-implied, 21d max drawdown | A170 / S046 |
| Covered calls | premium − max(0, S_T − K) on a 1σ-IV call | A170 / S046 |
Stock return / direction (rel_21, ret_5) is the wrong target for these — S042 called the tech score "≈ 0" on returns; on puts it sorted +15.7 bp/wk.

## 2. Data (point-in-time, local Postgres; connect via `scripts/watchlist_sync/build_plan.connect()`)
| Table | What | Span |
|---|---|---|
| `watchlist_sync.lab_outcomes` | weekly (Mon) panel, 252 tickers: features (iv30, iv_rv, iv_rank_1y, beta, idio_vol, mom_12_1, dist_ma200, dd_52w, rev5, earnings_21, spy_dd_52w, mkt_med_dd, spy_vrp, alpha) + outcomes (ret/rel 5/21/63/126, mae_21, mfe_21, rv_fwd_21, vrp_real) | 2020-02 → 2026-10 |
| `watchlist_sync.lab_tech` | engine tech scores on the same dates: `v2` (comps + total), `v4_put`, `v4_call`, `inputs` | same |
| `watchlist_sync.lab_fund` | IBES: sue, drift, breadth, disp, numest | same |
| `lseg_research.daily_history` | **split-adjusted daily OHLCV + iv30/60/90 put/call**, 273 tickers | 2016 → |
| `prices_historical` | app's daily bars — **only from 2025-04**; don't backtest on it | 2025-04 → |
| `optlab.*` | Jamie's real option trades (551), legs, chain closes, earnings moves | ~1 y |
| `optlab.lseg_opt_daily` | **LSEG daily option bid/ask/mid/OI/IV, any contract incl. expired** (`research/lseg/option_prices.history()`, run in `research/lseg/.venv`). First choice for daily option backtests | 2024 → |
| `optlab.contracts` / `optlab.bars` | real daily option closes, ~100 book names; `option_history.chain()` / `fetch_bars()` fill gaps from Polygon (5 calls/min) | 2024-10 → |
| `optlab.minute_bars` | 1-min **trade** bars (no quotes on our plan): SPY full 2026 + fetched contracts; `s048_0dte.minute_bars()` caches | 2026-01 → |
| `ticker_registry.primary_peer_group_id` | fine peer group per stock (39 groups, 22 with ≥ 5 members); `.split('.')[0]` = sector | static |
| `watchlist_sync.strategies` / `strategy_trades` / `strategy_equity` | Strategy Library (Track Record › Strategies); written only via `analysis/strategy_lib.py` | 2026-01 → |
| `option_score_snapshots`, `model_recs` | live option scores + component_scores JSON, Friday picks | 2026-10 → |
| `watchlist_sync.grades` | live Model List grades (folder × horizon) | 2026-10-09 → |
| `fair_value_snapshots` | FV history (live only) | 2026-10-06 → |

## 3. The harness (copy it, don't start blank)
`scripts/watchlist_sync/analysis/s045_put_retest.py` — `load()` pulls lab + LSEG; `build()` makes one event per (ticker, Monday):
strike K = S·exp(−IV·√(5/252)), BS premium, pnl, breach, plus features. `fm()` = weekly cross-sectional Spearman (Fama-MacBeth) with
controls; `quint()` = top/bottom quintile breach + pnl bp; `ts_test()` = week-level (regime) features.
- Add a feature: compute it in `build()` from bars ≤ as_of only, add the key to `xs`. Run: `cd scripts/watchlist_sync && .venv/bin/python analysis/s045_put_retest.py` (~25 s).
- Reuse events in a scratch script: `import s045_put_retest as M; ev = M.build(*M.load(M.connect()))`.
- Python: always `scripts/watchlist_sync/.venv/bin/python` (numpy; no scipy — use the harness `rank()`).
- Runs > 1 min on Jamie's Mac (Jamie 10-24: backtests ate every core while he worked): prefix `nice -n 15 env OMP_NUM_THREADS=4` — low priority, ≤ 4 cores for sklearn/numpy.
- Every new signal uses the cached panel first: `analysis/lab.py signal --module path.py:func` or `--expr` (stock board, rel_21, A262 bar) and `analysis/s045_put_retest.py signal` (puts: Q5−Q1 pnl/breach vs the put_edge quintile). A new script only if that harness cannot express the idea. Cold cache build is the slow step; a warm signal is seconds. The signal at date d may use only data dated ≤ d (`align_asof` / `trailing_net`).

## 4. Checks every result must pass (in this order)
1. **IV fixed:** strike scales with IV + residualize on iv_rv, iv30, earnings_21 within week. Raw pnl IC re-learns IV (S045: 0.26 → 0.03).
2. **Extra controls:** mom_12_1, dist_ma200, dd_52w, beta, idio_vol, rev5 — does it survive? (oversoldDepth didn't.)
3. **Mechanical / placebo:** if the label depends on distance or vol, a random level/shuffled feature must score ≈ 0 (S041 "PASS" was distance-to-floor; random lines scored 0.624).
4. **Out of sample:** fit weights on the first half of weeks, test on the second; both halves same sign.
5. **Bar:** |t| ≥ 3 after controls (≥ 2 for a pre-registered single feature), economic size in bp/week of collateral.
6. **Ties:** binary/discrete features need average ranks (`rank()` in the harness) — argsort ranks garbled S045 v1.
7. **Dates:** check the weekday before calling a day "missed" (10-17-2026 is a Saturday).

**4b. "Everything loses" is never a verdict (Jamie 11-06, said many times).** A loss is a trade for the other side. Every packet ends with:
1. **Comparator:** universe-relative (excess vs same-window median) + random same-delta/same-week pick + T-bill. Raw P&L alone = invalid packet. Random pool = **same day, vol-matched**; never "same ticker, same month" (the pool carries the drop the signal waits for → fake +300 bp on every fade, A341 11-06).
2. **Mirror:** the opposite side on the same rows (short ↔ long, sell put ↔ buy put / avoid). Worse than random at |t| ≥ 2 = a fade signal → test it as one.
3. **What works:** the best cell found (state × structure × side) with n, bp/week, worst week, vs comparator. If both sides ≈ random, say "X carries no information — trade the base", name the base and its number.
4. Lead the packet with (3); "fail" lines ≤ 1.

**Put-engine changes: benchmark gate (Jamie 10-28).** Before any factor / regime / strike rule reaches put_recs, register it as a variant in `analysis/put_benchmark.py` and get **BETTER** vs the live engine (holdout and pre-2023 both). It also lists the Alpaca wheel score and fixed 0.11Δ as public/naive baselines.

## 5. From result to product (the A167 pattern)
1. Find where the feature enters (`codegraph`): put lane = `lib/option-scoring` → `option-score-snapshots.ts` (Rankings) **and** `model-track-record.ts` (Friday model_recs → Model List); both read `api-server/src/lib/put-scoring-inputs.ts`.
2. Make it a champion param (`scorecard_params`, lane options/tech/fund/fair_value), default = old behaviour.
3. Before/after on live snapshots (`api-server/src/scripts/a167-before-after.ts`): rank corr, top-N overlap, **gate counts** (stockQuality floor 0.45 — level shifts silently gate names; quantile-match levels).
4. Promote with a script that records rationale + evidence + rollback (`scripts/watchlist_sync/promote_options_1_1_0.py`). Jamie asking for the task = approval (AGENTS 7).
5. Grade live: shadow score (A172) + `analysis/scoreboard.py` (Settings › Research); verdict at ≥ 8 expiries / ≥ 100 picks.

## 6. Already answered (don't redo — see INDEX)
Works for puts: IV/RV (S003), put-tuned tech = trend − volumeConfirm (S045, live), volume node between K and S = worse (S045).
Works for calls: low volume + not stretched above the 200-day (S046, live options-1.2.0); current call tech total was wrong-way.
Avoid list: no reconstructable flag (falling knife, IBES, alpha) predicts ≥ 2σ crashes beyond IV; low alpha / high idio vol → deeper drawdowns (S005/S046).
Harnesses: puts `analysis/s045_put_retest.py`, calls + Avoid `analysis/s046_calls_avoid.py`. Live grading: `analysis/scoreboard.py` (Settings › Research).
Null on puts (IV-controlled): HAR, 2σ-drop, streaks, SUE, IBES drift/breadth/disp, regime mean (sizing marginal), swing-low support.

## 7. Trading-strategy studies → Strategy Library (A176)
Rule-based strategies (not score features) go here: pre-register in the ASKS file (rule, split, pass bar), one run, then publish
pass **or fail** via `strategy_lib.write_rows()` + `equity()` (`bankroll=` for long-option / pair lanes; default = put-book weekly
compounding). Templates: event study `s050_sector_laggard.py` (numpy, 2018→, ~4 s); real option closes `s049_panic_puts.py`;
intraday `s048_0dte.py`. Backlog = A184 / A188. **Order every time:** 5-name smoke run with trades hand-checked → full run → if FAIL or mixed, winner-pattern pass (`s054_panic_put_patterns.py`) → `conditions_grid.py <study>` (market / vol / sector-trend / sector / IV band; save trades to `watchlist_sync.study_trades`) → confirm on an untouched period (e.g. 2025). Compute is seconds; Polygon's 5 calls/min is the only slow part → background it.

