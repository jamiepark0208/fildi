# Trade funnel — regime → view → structure → sector → stock → one list → end-of-day audit
Jamie 11-09: "processes to check regime → narrow views → narrow which trades to check (full coverage of option trades by view,
but only check the ones relevant to the regime); stocks too: sector first, then narrow by intraday moves; end of day check, verify,
learn from mistakes — incl. tickers where the model failed to capture a better trade, understand why, improve."
Owner: Claude (builds; Cursor on weak models). One step per session. Status in `.agents/context/state.md`.

## Principle
- Cheap pass on everything, expensive pass on the shortlist. Model-price every name × every structure family from daily bars + iv30 (no chains). Pull real Schwab chains only for what survives.
- A narrowing stage is allowed only if it keeps the winners. **Stage recall** = share of the day's top-decile trades (graded later) that survived the stage. Every stage logs what it cut, so the end-of-day audit can say which stage dropped a missed winner.

## What exists (reuse, don't twin)
| Stage | Exists | Gap |
|---|---|---|
| Market regime | panic gate (market_not_panic), S101 sharp-drop, S172 un-invert, house_view index odds, regime-classifier.ts (macro), intraday-regime.ts (trend/reversal day) | no single daily label; no tested map label → allowed views |
| View → structures | structures.py 16 structures, families short_premium / long_premium / directional / time / hedge; strategy_engine.py gates | regime_fit is per stock (IV/RV, 50-day), not market regime |
| Sector → stocks | sector_etf_daily, live-movers.ts, Model List funnel (all names) | no sector-first step; intraday re-check covers only the published list |
| Rules → picks | strategy_signals (every strategy_id, /api/strategy-signals/active), put_recs, long_option_board, structure_rank_daily | no single ranked "Today" list |
| End of day | daily_reflection.py (short-put found-wrong / missed only, last ran 11-05), grade_ledger.py, forecast_ledger, learn.py | no universe-wide best-trade oracle; no stage attribution |

## Revised design after S175/S176 (11-09)
Neither market regime nor sector/movers can cut the search without losing most winners (recall 12 % / lift ≈ 1). So: price **every** name × structure family cheaply (bars + iv30, $0) → rank by tested stock-level edge scores with the regime as prior/size → real chains only for the top of that ranking → Today list. The EOD audit measures the recall of that ranking stage; that is the stage to improve.

## Steps (in order, one per session)
1. **S175 regime × structure matrix — DONE 11-09: FAIL as hard filter (recall 12 %) → regime = view prior + sizing (bearish/condor/calendar never get a regime prior; long calls calm_up/bottom only); stock-level edge scores narrow.** Label every day 2018→ with the tested regimes: panic (S054), sharp drop (S101), un-invert (S172), calm uptrend, chop. Model-price each structure family on the whole LSEG universe in each regime. Output = which views and structures pay per regime vs their own any-day, both halves, plus the recall of "only check the regime's allowed structures" (share of top-decile trades kept). Becomes `strategy_rules.json` → `regime_views`.
2. **S176 sector narrowing — DONE 11-09: (b) FAIL, lift 0.99–1.12 vs random → no sector/mover cut; cheap-price every name, narrow on edge scores before chains. (a) theme-momentum calls still to run.** Rank theme/industry groups (sector_etf_daily + GICS industry) by 60-day return and today's move. Test: (a) theme-momentum cheap-IV calls vs S100 (the S174 winner-pass lead); (b) recall of "scan only the top/bottom k groups + the day's top movers" vs scanning all names. Pick k from the recall curve (≥ 80 % of winners kept).
3. **DONE 11-09 (daily; intraday re-run not built):** trade_funnel.py shortlist (before skew_survey) prices 877 names × 3 families (0.20Δ sold put, 0.50Δ call/put, 30 DTE, iv30 vs RV20) in 0.7 s, score = ½ cheap-EV pct + ½ tested edge pct (put_edge pnl_bp / S086 overlap) × S175 prior 0.7 off-regime (weights unvalidated → step 4 judges); top 80/50/30 → skew_survey forced list (replaces put-edge Q4+) → chains 352 → 193 names/day. trade_funnel.py today (after S172) = put engine + Strategies board primary + strategy_signals last 2 signal days + forecast_ledger long_call_ts → one list ranked tier → regime fit → #rules → funnel score (11-09: 179 picks). GET /api/trade-funnel/today; Live 'Today' card (Playwright 0 errors). Original spec: **trade_funnel.py (daily + intraday).** Regime label → allowed views → structures → groups → stock shortlist → real chains on the shortlist only → one ranked "Today" list (every registered strategy_id plus structures). Table `watchlist_sync.trade_funnel_daily` logs every stage (in / out / reason). API + Live "Today" block. Intraday: re-run the sector/movers stage at the regime checkpoints that already exist (scheduler.ts).
4. **eod_audit.py (after close, in daily.py).** Oracle: model-priced best trades per view/structure across the full universe at 5/10/21-session horizons (graded once the horizon passes). Compare with what we showed. Each top-N miss gets the stage that cut it (regime view, structure gate, sector cut, stock gate, rank). Table `watchlist_sync.missed_trades` plus stage recall per day. Replaces daily_reflection §3, which was short puts only.
5. **Learn.** Weekly: a stage whose recall falls below its bar, or a miss kind repeating on ≥ 5 days, becomes a pre-registered study (no hand-tuning). Wire into learn.py evidence plus the Ideas queue.

## Success checks
- Step 1: matrix table with n, both halves and comparator for every cell; recall of the regime filter reported.
- Step 3: Today list renders on Live (Playwright, 0 console errors); chain calls/day before vs after (must drop vs the full scan); every stage row in trade_funnel_daily.
- Step 4: missed_trades rows for 1 replayed past day, each with a stage; stage recall printed.
