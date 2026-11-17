# S194 — which of Jamie's put sales were good vs bad (A410 part 7, Jamie 11-17)

**Ask:** "differentiate between good and bad trades that i did" — not copy all his history.
**Script:** `scripts/watchlist_sync/analysis/a410_good_bad.py` → `out/studies/S194-graded-trades.csv`.
**Data:** 1,526 short-put opens 2026-01-21 → 11-09, 40 names, 43 entry weeks (independent unit). Held to expiry (rec_scoreboard.grade).

## Grades
| grade | n | share | avg % of strike | sum |
|---|---|---|---|---|
| clean (kept, strike never touched) | 1,007 | 66 % | +1.09 | +1,094 |
| risky win (kept, strike touched) | 250 | 16 % | +1.05 | +262 |
| loss | 269 | 18 % | −3.87 | −1,041 |
Losses cancel nearly all the clean gains.

## What separates clean from risky/loss — within the same entry week (luck control), week-clustered t
| trait | clean median | bad median | Δ P(bad) per +1 SD | t |
|---|---|---|---|---|
| strike % below price | 12.3 | 8.0 | −10.3 pp | −3.0 |
| implied vol of the fill | 109 | 93 | −9.1 pp | −3.0 |
| QQQ 20 d return | +0.5 | +3.0 | +6.1 pp | +2.4 |
| 20 d realized vol | 84 | 73 | −7.4 pp | −2.3 |
| strike in σ | 1.12 | 0.92 | −3.1 pp | −2.3 |
| % above 20 d low | 10.3 | 8.8 | −6.7 pp | −2.1 |
| % off 60 d high | −34 | −26 | +4.7 pp | +1.6 (ns) |
| IV÷RV, earnings before expiry, DTE, 5 d return | — | — | — | ns |

Correction to S192: "beaten-down" mostly reflects the market week, not the pick (t 1.6 within week). Strike depth is the trait that holds inside a week.

## Held-out (fit < 2026-04-01: 300 trades / 11 wk; test 1,226 / 33 wk)
| model | test AUC | P(bad) low / mid / high tercile: bad rate · avg ret |
|---|---|---|
| Journal odds (strike depth + off 60 d high) | 0.679 | 17 % +0.69 · 32 % +0.10 · 52 % −0.34 |
| + IV÷RV, earnings | 0.670 | — |
| + strike σ, 5 d return, RV | 0.658 | — |
| all traits | 0.675 | 14 % +0.65 · 38 % +0.22 · 49 % −0.45 |
Extra traits do not beat the live Journal odds model held out (train is only 11 weeks). IV and realized vol overlap with strike depth (high-IV names get deeper strikes).

**Verdict:** the live Journal odds model already sorts good from bad (bad 17 % → 52 % across terciles, held out). Adding IV, IV÷RV, earnings or momentum gives no lift at this n. Caveat: his own 40 names and one year; next = the same split on universe history (A410 part 3 study) before the engine uses it.

## So what
- For your trades: the cheapest change is strike depth. Strikes within ~8 % of price produce most of the risky wins and losses, even in the same week. Selling after QQQ has run up 3 %+ in 20 days also raised the bad rate.
- In Fildi: Track Record › Journal has a new **Result** column (Clean / Risky win / Loss) on each sold put held to expiry; the tooltip carries these numbers. The Odds column next to it is the held-out best predictor.
