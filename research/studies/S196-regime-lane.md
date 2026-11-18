# S196 — rich-put lane in SPY < 200 d weeks + drop 6–10 % OTM picks, vs engine proxy (A410)

**Script:** `scripts/watchlist_sync/analysis/s196_regime_lane.py` → `out/studies/S196.md`. Trades = S195's (real LSEG EOD put quotes, 6,615 trades, 246 names, 284 weeks, 2020-12 → 2026-10; 3–9 DTE held to expiry; stress fill = bid).
**Books per week (≤ 10 names, one put each):** E = engine proxy (|Δ| 0.06–0.20, bid ≥ 0.3 %/wk, IV ÷ RV20 ≥ 1.15, ranked by ev_rv_cap) · E- = E without 6–10 % OTM strikes · R = S109 rich lane (bid ≥ 0.9 %/wk, ≥ 10 % OTM, ≥ 25 % off 252 d high, income + OTM percentile) · G = R in bear weeks, E in bull.
**Proxy gaps:** no band_engine state bands, put-edge Q gate, earnings push-out or OI filter. Thin universe: ~2–3 E picks / week, ~1 R pick, not 10.
**Pre-registered:** regime SPY vs 200 d; bear R − E > 0, E- − E ≥ 0 both; pass = paired week diff > 0 at stress, t ≥ 2, ≥ 30 weeks, worst-5 % week not worse by > 0.5 pt.

## Result (stress fill, %/wk of strike, week-averaged)
| regime | book | weeks | mean | loss | worst-5 % wk | mean/sd |
|---|---|---|---|---|---|---|
| bear | E engine proxy | 38 | +0.47 | 15 % | −0.63 | 0.55 |
| bear | E- no 6–10 % | 37 | +0.62 | 12 % | −0.66 | 0.82 |
| bear | R rich lane | 36 | +1.20 | 6 % | −1.25 | 0.97 |
| bull | E engine proxy | 148 | +0.01 | 15 % | −2.64 | 0.00 |
| bull | E- no 6–10 % | 125 | +0.10 | 13 % | −2.62 | 0.07 |
| bull | R rich lane | 65 | +0.70 | 16 % | −3.44 | 0.37 |

Paired weeks: E- − E bear +0.16 (t 1.1, 37 wk) · bull +0.05 (t 0.9, 125 wk) → **no lift** (right sign, not significant).
R − E bear +0.49 (t 2.7, 31 wk) but worst week −0.76 pt worse → **fails the risk bar**; bull +0.70 (t 3.7, 60 wk), worst week −0.47 → **pass**.
G − E all weeks +0.09 (t 2.5); halves +0.14 (t 2.3) → 2024-06 · +0.02 (t 1.3) 2024-07 →.

**Live (shadow) check, 3 graded weeks 10-26 → 11-09:** rich lane (every name's rich put, n 390) −1.46 % per trade vs engine top-10 (n 69) −1.42; rich trailed in both calm weeks (−0.19 vs +0.83, +0.23 vs +0.78). Can't answer at this n.

**Verdict:**
- Drop 6–10 % OTM: **NO-LIFT** — rule tested = remove 6–10 % OTM strikes before the engine-proxy pick, same weeks, stress fill. +0.05 to +0.16 %/wk, t ≤ 1.1.
- Gate rich lane to SPY < 200 d: **wrong shape** — on history the rich lane beats the engine proxy in bull weeks too (+0.70, t 3.7), so a bear-only gate drops the bigger cell. Bear: higher mean but worse worst week (fails the pre-set risk bar). Same finding as S109 (+101 vs +14 bp), not new evidence. Live 3 weeks say the opposite → stays shadow.

## So what
- For your trades: nothing new. Far-OTM rich puts on beaten names keep testing well on history; the last 3 live weeks didn't show it.
- In Fildi: not yet — no engine change. Rich lane stays shadow (payload.rich, rich_puts folder). Revisit when ≥ 8 graded live weeks: promote if rich top-10 ≥ engine top-10 at stress fill.
