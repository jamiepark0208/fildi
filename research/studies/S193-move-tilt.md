# S193 — state tilt on IV-implied move odds (A410 part 6 steps 1–2)

**Question:** do drawdown / IV÷RV / SPY-trend states shift the real 21-day move distribution away from what IV implies, enough to give every option structure better odds than the market's?
**Script:** `scripts/watchlist_sync/analysis/s193_move_tilt.py` (`CELL=state|iv|iv_dd`).
**Data:** LSEG `lseg_research.daily_history` IV30 (put/call mean) + closes; 919 tickers alive today; one obs per ticker-Friday, 2020-01 → 2026-10, n 120k (pre-2020 ≈ 100 obs/yr → dropped).
**Independent events:** 82 months (cluster unit for every t); 7 calendar years (leave-one-year-out folds). Cell n 593–18,895 obs; every cell ≥ 30 months.

## Pre-registered
- State at entry close (no look-ahead): drawdown off 60 d high (< 5 / 5–15 / 15–30 / > 30 %) × IV30÷RV20 (< 0.9 / 0.9–1.3 / > 1.3) × SPY vs 200 d SMA (bull / bear).
- Expected sign: IV rich (> 1.3 RV) → thinner tails both sides; deep drawdown in bull → thinner left tail (mean reversion); bear → fatter left tail.
- Pass bar: state-cell model beats the **one global correction** (market odds + average excess) on held-out Brier, month-clustered t ≤ −2.

## Result
| event (21 d) | actual | market implied | Brier market | + global | + state cells (t vs global) | + IV-level cells (t) |
|---|---|---|---|---|---|---|
| down 0.5σ | 27.8 % | 33.2 % | 0.2037 | 0.2013 | 0.2026 (+1.7) | 0.2013 (+0.5) |
| down 1σ | 14.0 % | 17.5 % | 0.1217 | 0.1206 | 0.1211 (+1.5) | 0.1205 (−0.7) |
| down 1.5σ | 6.2 % | 7.6 % | 0.0587 | 0.0585 | 0.0586 (+0.7) | 0.0584 (−1.8) |
| up 1σ | 16.6 % | 14.4 % | 0.1389 | 0.1385 | 0.1391 (+1.8) | 0.1386 (+1.6) |

Signs: bear cells show +0.2–0.4σ median (2020/2022 rebounds) — year effects, gone held-out. IV > 80 %: implied 19.9 % vs actual 12.7 % for a 1σ drop, but survivorship (dead high-IV names missing) inflates exactly that cell.

**Verdict: RULE NO-LIFT** — rule tested = price each structure off IV odds shifted by a shrunk (m 200) drawdown × IV÷RV × SPY-trend cell excess, 21 d hold to expiry. It does not beat one global "IV overprices downside" correction held-out. Survivorship makes even the global ~3.5 pp an upper bound.

## Winner pass
- Winners = cells whose held-out excess kept its sign every year: only the IV-level split (higher IV → larger downside overpricing) does; drawdown and SPY-trend cells flip by year.
- Pre-entry pattern: IV level itself, not state. Confounded with survivorship.
- Next rule to test: IV-level tilt on survivorship-free history (CRSP incl. delisted, WRDS) — if it holds there, it is the one tilt worth feeding `priceStructure`.

## So what
- For your trades: nothing new — the Journal odds grid stays the per-trade view.
- In Fildi: not yet — A410 steps 3–4 (adjusted odds column) parked; Ranker/Builder keep market odds. Revisit-when: CRSP delisted history or ≥ 3 more IV years.
