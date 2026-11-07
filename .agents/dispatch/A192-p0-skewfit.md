# A192 Phase 0 exit — skew model fit (Cursor study, read-only on DB)
Read: research/common/asks/A192.md, research/studies/PLAN-option-structures.md § Phase 0 row (L61) + § v2→v3 (L75).
Data: optlab.skew_survey (as_of, ticker, expiry, side, strike, spot, bid, ask, mark, iv, delta, oi, volume, quote_time); 14 days 2026-10-19..11-06, 638 tickers, 201 k rows. Python: scripts/watchlist_sync/.venv/bin/python. New script: scripts/watchlist_sync/analysis/skew_fit.py (no schema changes).

Goal: can we predict wing IV from ATM IV well enough to price structures? Pass bar (pre-registered, from the plan): holdout MAE ≤ 2 vol pts.
1. Clean: bid > 0, ask > bid, 0.01 < iv < 3, 7 ≤ DTE ≤ 45, OTM side only (puts K<S, calls K>S), mid ≥ $0.05. Per (as_of, ticker, expiry): ATM IV = interpolate at log(K/S)=0 from the two nearest strikes; drop groups without both sides of ATM.
2. Target: iv / atm_iv − 1 (relative skew). Features: k = log(K/S)/(atm_iv·√T), DTE, atm_iv level, side, ticker IV-rank bucket if cheap (else skip).
3. Models (smallest first): (a) per-ticker 7-day-old smile copied forward (naive baseline); (b) pooled quadratic in k by side, coefficients linear in atm_iv and √T; (c) (b) + per-ticker intercept/slope shrunk to pooled (ridge). No ML beyond that.
4. Holdout = time split: fit on as_of ≤ 2026-10-30, test 2026-10-31..11-06. Report MAE in vol pts on absolute IV, overall and by |delta| bucket (0.05–0.15, 0.15–0.30, 0.30–0.45), by DTE bucket (7–14, 15–30, 31–45), liquid (OI ≥ 500) vs rest, and SPY/QQQ separately.
5. Also report median relative bid-ask (ask−bid)/mid by the same delta × DTE buckets (feeds the plan's fill model).

## Smoke gate (before the full run; stop and report if any fails)
Slice: SPY, QQQ, AAPL, one as_of (≤ 2 min).
1. ATM IV per expiry printed for SPY: within 10–30 %, rising-or-flat with DTE not jumping > 5 pts between adjacent expiries.
2. Put skew sign: SPY 0.15Δ put IV > ATM IV (print both). If not → bad cleaning, stop.
3. Row count after cleaning printed vs before; < 30 % kept → stop and print why.

Packet ≤ 20 lines appended to research/common/asks/A192.md under ## Reviews as **Cursor packet <date>:** — the MAE table (rows = model, cols = delta buckets + overall), pass/fail vs 2 vol pts per bucket, which buckets fail, spread table, row counts. Commit `Refs: A192`, `Agent: cursor`. Do not touch ASKS.md status, engines, or UI.
