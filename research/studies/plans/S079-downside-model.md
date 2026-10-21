# S079 — Downside-ranking model (A222): does a gradient-boosted P(breach) pick better weekly puts than live put edge?

Pre-registered 2026-10-21 (Claude, Jamie: "did you enhance the downside model with what you said is missing?"). One run, no re-cut.

## Why (so what)
The ranking decides which names get puts each week. Live put edge (3 factors: IV/RV, vol-of-vol, put tech; `put_edge.py`)
earns only in its top quintile (+23.0 bp/wk, breach 10.5 %; Q4 ≈ 0; Q1–Q3 < 0 → blocked). A better ranker = more/better
names in the earning set. Worth ≈ +2–4 bp/wk on picked names (~$1–2k/yr on ~$100k collateral) if it adds IC 0.02–0.04.

## Data (0 vendor calls)
- Trades: `analysis/s059_option_factors.py` → `aligned_events(conn)` + `add_features(conn, ev)` (same-week NYSE horizon,
  ~25.8k+ weekly ~1σ puts 2020→, pnl net of fills = bid + 23 % of spread, breach = S_T < K). Reuse; don't fork.
- Features already there: iv_rv, vol_of_vol, put_tech, term_slope, skew, idio_vol, mom_12_1, rev_1m (+ whatever add_features adds).
- Add OHLCV features from the same price panel (point-in-time, entry-day close or earlier only): ret 5/20/60 d, close vs
  20/50/200-day MA, 20-day max drawdown, ATR14 / close, volume z (20 d), RSI14, 60-day beta to SPY, days to next earnings if
  available in the panel (else omit — never look ahead).

## Model
- `sklearn.ensemble.HistGradientBoostingClassifier` (install scikit-learn into `scripts/watchlist_sync/.venv`; free).
  Fixed params (no tuning on test): max_depth 3, learning_rate 0.05, max_iter 300, min_samples_leaf 200, l2 1.0.
- Label A: breach. Score = predicted P(breach) (lower = better put). Also report a regressor on pnl (same params, HGB regressor).
- Walk-forward: expanding, train on all weeks < test-year start minus 7-day embargo, test each calendar year 2022 → 2026.
- Comparators on identical test rows: (1) live put-edge composite rank (same definition as `put_edge.py` / S059 composite),
  (2) logistic regression on the 3 put-edge factors (z-scored).

## Outputs (out/opt/S079.md)
1. AUC + Brier for breach per year and pooled (model vs logistic vs put edge).
2. Quintiles by model score: mean pnl bp/wk, breach, n — next to the same table for put edge.
3. **Decision metric:** each week pick the top quintile by model vs top quintile by put edge; paired weekly difference in
   mean pnl (bp/wk), week-cluster t, both halves of the 2024-07 → holdout, breach difference.
4. Marginal: within put-edge quintiles, model top − bottom tercile pnl (week-cluster t).
5. Feature importances (permutation, holdout) — top 10.

## Pre-registered pass
Paired weekly difference (model top quintile − put-edge top quintile) on the 2024-07 → holdout > 0 with week-cluster
t ≥ 2, both halves > 0, and breach not higher. Pass → propose as a challenger factor (shadow, no live change). Else FAIL:
no factor; report what it learned (importances) in plain words.

## Process
Smoke test on 5 names first with 3 hand-checked trades (print features + label for them). Then full run. Add an INDEX row
(`scripts/md_rows.py upsert research/studies/INDEX.md S079 …`) with the verdict in plain words. No live code changes.
