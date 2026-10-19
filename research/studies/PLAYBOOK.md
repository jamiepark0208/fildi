# Backtest playbook — how to answer "does X help Jamie's trades?" (all agents)

> Claude 2026-10-18, from S041–S045. Rules = `METHODS.md`; this is the hands-on how. Read `INDEX.md` first (maybe it's answered).

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

## 4. Checks every result must pass (in this order)
1. **IV fixed:** strike scales with IV + residualize on iv_rv, iv30, earnings_21 within week. Raw pnl IC re-learns IV (S045: 0.26 → 0.03).
2. **Extra controls:** mom_12_1, dist_ma200, dd_52w, beta, idio_vol, rev5 — does it survive? (oversoldDepth didn't.)
3. **Mechanical / placebo:** if the label depends on distance or vol, a random level/shuffled feature must score ≈ 0 (S041 "PASS" was distance-to-floor; random lines scored 0.624).
4. **Out of sample:** fit weights on the first half of weeks, test on the second; both halves same sign.
5. **Bar:** |t| ≥ 3 after controls (≥ 2 for a pre-registered single feature), economic size in bp/week of collateral.
6. **Ties:** binary/discrete features need average ranks (`rank()` in the harness) — argsort ranks garbled S045 v1.
7. **Dates:** check the weekday before calling a day "missed" (10-17-2026 is a Saturday).

## 5. From result to product (the A167 pattern)
1. Find where the feature enters (`codegraph`): put lane = `lib/option-scoring` → `option-score-snapshots.ts` (Rankings) **and** `model-track-record.ts` (Friday model_recs → Model List); both read `api-server/src/lib/put-scoring-inputs.ts`.
2. Make it a champion param (`scorecard_params`, lane options/tech/fund/fair_value), default = old behaviour.
3. Before/after on live snapshots (`api-server/src/scripts/a167-before-after.ts`): rank corr, top-N overlap, **gate counts** (stockQuality floor 0.45 — level shifts silently gate names; quantile-match levels).
4. Promote with a script that records rationale + evidence + rollback (`scripts/watchlist_sync/promote_options_1_1_0.py`). Jamie asking for the task = approval (AGENTS 7).
5. Grade live: shadow score (A172) + `analysis/scoreboard.py` (Settings › Research); verdict at ≥ 8 expiries / ≥ 100 picks.

## 6. Already answered (don't redo — see INDEX)
Works for puts: IV/RV (S003), put-tuned tech = trend − volumeConfirm (S045, live options-1.1.0), volume node between K and S = worse (S045).
Null on puts (IV-controlled): HAR, 2σ-drop, streaks, SUE, IBES drift/breadth/disp, regime mean (sizing marginal), swing-low support.
