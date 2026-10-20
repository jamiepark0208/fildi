---
name: fildi-grade-quality
description: Judge whether FILDI's scorecards, option scores and trade recommendations are actually good — backtest promise vs live results, drift, calibration, and what counts as enough evidence. Use for "is score X working?", "are the recs any good?", promotion/demotion of a score — any agent.
---

# Is it working? — grading scores and recommendations
Router + rules. Each tool's docstring has the details.

## Where the evidence lives
| Question | Tool / table | Run |
|---|---|---|
| Does each adopted score/rule still do what its backtest promised? | `analysis/scoreboard.py` → `watchlist_sync.scoreboard` (Settings › Research) | nightly via `option_history.py`; manual `.venv/bin/python analysis/scoreboard.py` |
| How did shown recommendations do? | `model_recs`, `watchlist_sync.grades` (folder × horizon), `grade_ledger.py` | nightly |
| Are our probabilities calibrated? | `watchlist_sync.forecast_ledger` (`forecast_ledger.py`): predicted vs realized, per pattern | nightly |
| Put-edge quintiles live vs backtest | `put_edge.py` + `put_edge_calibration.json`; drift fallback = `put_edge_status` | weekly |
| Re-simulate this week's recs | `analysis/sim_rec.py` (0.4 s) | ad hoc |
| Why is ticker X (not) on the Model List? | `scripts/watchlist_sync/funnel.py --ticker X` | ad hoc |
| What did the trader actually do / earn? | `optlab.*` (551 real trades), `analysis/grade_rh_trades.py`, S015 | ad hoc |
| Strategy track records | `watchlist_sync.strategies` / `strategy_trades` via `analysis/strategy_lib.py` | per study |

## Rules for a verdict
1. **Sample = expiry weeks, not trades.** Short-put outcomes cluster by week (S016 ρ ≈ 0.6). Live claims need ≥ 8 distinct expiries and ≥ 100 trades (`MIN_EXPIRIES`, METHODS rule 9). Before that, the answer is "too early", never "working".
2. **Compare to the promise, not to zero.** Each scoreboard row carries what the backtest promised; grade the live gap (holding / drifting / failed / too early / no live check). "No live check" is itself a finding → file a row.
3. **Rank quality ≠ return.** For option scores, measure IV-fixed rank IC within week and top-vs-bottom quintile on put pnl + breach (PLAYBOOK §4). Raw-return ICs re-learn IV.
4. **Calibration:** bin predicted P(assign) vs realized; S016 found market IV odds calibrated (18 % vs 21 %) → our own odds must beat market-delta odds to earn a place.
5. **Before/after for any change** that moves scores or what is shown: rank correlation, top-N overlap, gate counts (level shifts silently gate names), on live snapshots (`api-server/src/scripts/a167-before-after.ts`). Promotion scripts record rationale + rollback (`promote_options_1_2_0.py`).
6. **Demotion is as important as promotion:** drift rule → shadow → fallback, with the evidence written to the scoreboard row.
7. Same judgment rules as studies (`fildi-quant-research` §1): test the use, same-risk comparators, say the benefit plainly, challenge premises.
