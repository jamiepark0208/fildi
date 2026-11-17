# S195 — does strike depth (S194, Jamie's good vs bad puts) hold across the universe? (A410)

**Script:** `scripts/watchlist_sync/analysis/s195_depth_universe.py` → `out/studies/S195.md`.
**Data:** real LSEG EOD put quotes (optlab.lseg_opt_daily, all 12.1k put contracts it holds), 6,615 trades, 246 names, 2020-12 → 2026-10. 3–9 DTE, |Δ| 0.02–0.40, held to expiry; fill bid + 23 % spread, stress = bid. r = % of strike per week.
**Independent events:** entry weeks — bear 35–55 per depth cell, bull 108–222 (preflight: every cell ≥ 30). Same-stock-same-week pairs: bear 77 (18 wk), bull 222 (63 wk).
**Regime (pre-registered):** SPY vs 200 d SMA. Expected: deep − near ≥ 0 bull, > 0 bear; beaten ≈ 0; QQQ run-up → lower r.
**Entry:** EOD quote — not an entry-candle test (item 13); depth is a strike choice.

## Result (stress fill, %/wk, week-averaged)
| regime | depth | mean | loss rate | touched | sd | worst-5 % week | mean/sd |
|---|---|---|---|---|---|---|---|
| bear | < 6 % | +0.27 | 17 % | 50 % | 2.38 | −3.07 | 0.11 |
| bear | 6–10 % | +0.09 | 19 % | 34 % | 2.11 | −4.89 | 0.04 |
| bear | 10–14 % | +0.30 | 13 % | 27 % | 2.17 | −2.72 | 0.14 |
| bear | ≥ 14 % | +0.56 | 6 % | 23 % | 1.01 | −0.34 | 0.56 |
| bull | < 6 % | +0.32 | 14 % | 48 % | 1.12 | −1.58 | 0.29 |
| bull | 6–10 % | +0.01 | 15 % | 37 % | 1.63 | −2.27 | 0.00 |
| bull | 10–14 % | −0.05 | 13 % | 27 % | 1.98 | −3.96 | −0.02 |
| bull | ≥ 14 % | +0.13 | 9 % | 27 % | 1.43 | −2.68 | 0.09 |

Within week, ≥ 14 % − < 6 %: bear +0.05 (t 0.17, 35 wk) · bull −0.01 (t −0.08, 108 wk). Same stock same week, deepest − nearest: bear −0.19 (t −0.47) · bull −0.26 (t −1.34). 6–10 % trails < 6 % in both (t −2.1 / −2.2).
Beaten (≥ 40 % off 60 d high) − not, within week: bear **+0.63 (t 2.39, 33 wk)** · bull −0.07 (t −0.20). QQQ run-up ≥ 3 %: better weeks, not worse (bear +0.75 vs −0.02; bull +0.23 vs +0.15) — S194's run-up finding does not carry over.

**Verdict: RULE NO-LIFT for return** — rule tested = sell the ≥ 14 % OTM strike instead of the < 6 % strike, same name/week, 3–9 DTE held to expiry, stress fill. Deeper strikes lose less often (bear 6 % vs 17 %) but do not earn more per week in either regime. Jamie's depth split is a smoother-ride effect, not a return effect. Unequal-risk caveat: in bear weeks ≥ 14 % had a far smaller worst week (−0.34 vs −3.07) — descriptive, not tested for significance (35 wk).

## Winner pass
- Winners = cells with the best mean/sd: bear ≥ 14 % (0.56) and bull < 6 % (0.29). Depth that works flips with regime; the 6–14 % middle is the worst cell in both.
- Pre-entry pattern: in bear weeks the beaten-down names earn more within the same week (+0.63, t 2.4) — the S109 rich-put lane / S054 panic-put mechanism, not a new one.
- Next rule to test: S109 rich-put lane (≥ 10 % OTM, ≥ 25 % off high) promoted only when SPY < 200 d, vs the live top-10 in the same weeks; and drop the 6–10 % band from engine picks (worst cell both regimes).

## So what
- For your trades: your deep strikes buy fewer losses, not more money — in a bull tape the near strike earned more per $ of strike. In bear weeks, deep strikes on beaten names were the best cell.
- In Fildi: not yet — the engine does not move to deeper strikes. Candidates in order: regime-gated rich-put lane, then drop 6–10 % OTM picks.
