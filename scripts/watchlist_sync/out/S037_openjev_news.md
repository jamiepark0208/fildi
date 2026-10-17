# S037 — OpenJev use cases: news reading, triage, data QA (A129, 2026-10-17)

**Question:** last test (forecast questions) lost to market odds. Public Jev/OpenJev projects (awesome-jev, ~100 repos) use it as a
gate / router / labeler / judge, never as a price forecaster. Test those uses on fildi data with labels that resolve at once.
**Copied method:** Lopez-Lira & Tang 2023 (LLM reads a headline → good/bad for the stock → compare with the move).
**Data:** Finnhub company news 2026-07-15…10-15, 90 tickers (30 per dollar-volume tercile, seed 17), ≤ 40 headlines per ticker,
deduped → 3,913 headlines. Local openjev-latest (DiffusionGemma 26B, MLX), 6 questions per headline, 0.9 s/headline, peak 21 GB, $0.
**Timestamp convention:** Finnhub publish time (no first-seen). Headline before 09:30 ET (or after 16:00 prior day) → graded on that
day's close-to-close move vs SPY (gap incl., "reads news"); intraday headline → graded on the NEXT session only (tradable).
Abnormal = stock − SPY, z = abn / 60-day sd. CIs = 90 %, day-bootstrap. Keyword baseline = small positive/negative word lexicon.
**Re-run:** `openjev_news.py --fetch / --run --per-ticker 40 / --report / --verify-analyst` (cache `research/openjev/news/`, gitignored).

## Pre-registered pass rules → verdict
| Use | Rule | Result | Verdict |
|---|---|---|---|
| Reads news direction | IC > 0, CI excl. 0, beats keywords | IC +0.10 (+0.15 relevant); vs keywords +0.02…+0.03, CI spans 0; where keywords are silent (72 %) IC +0.05…+0.09, CI excl. 0 | **pass on coverage**, not on accuracy |
| Tradable signal | next-day or open→close IC CI excl. 0 | −0.01 / −0.03, CI spans 0 | **fail** (2nd time; no price forecasting) |
| Materiality | AUC lower CI > 0.55 and > news count | 0.65 [0.58, 0.71] vs count 0.61; diff +0.035, CI spans 0 | **fail** (≈ news count) |
| Relevance gate | roundup P(rel) < 0.3, company news > 0.6 | 0.26 vs 0.55 | **partial** (filters roundups; company side low) |
| Analyst headline extraction (U2) | — (exploratory) | action from headline 87/91 = 96 %; roundup-linked rows flagged 74/76 | **pass** |

## Findings
- OpenJev is a free **news labeler**, not a forecaster: it reads direction and event type in headlines that regexes miss, at ~1 s each, $0.
- "Bad + material" pre-open alert: 22 ticker-days, 45 % fell > 1σ (base 13 %), but most hits are headlines reporting a move already
  under way ("Plummets", "Down 12 %") → it summarises the gap, it does not predict it.
- Movers by OpenJev event type (pre-open): earnings P(|z|>2) 0.22, legal 0.12, deal 0.08, analyst 0.05, roundups 0.08 (half of all headlines).
- **Data bug (U2):** 35 % (76/216) of `analyst_events.news_title` links are generic roundups ("Wall Street's top analyst calls", "What You
  Missed On Wall Street"), e.g. 8+ different SWKS rating changes all linked to one Nike/Home Depot roundup. The yes/no "record matches
  headline" question over-flags (FMP files a downgrade's PT as a price-target row); the choice question is the one to use.
- Calibration: P(good) is near 0 or 1 for 92 % of headlines (sharp, uncalibrated) → use it as a rank / label, never as a probability.

## Raw report
```
v0: 3913 headlines (2359 overnight/pre-open, 1554 intraday→next day), 89 tickers, 67 days

## Direction: rank corr of signal vs abnormal move (z = abn / 60d sd), 90% CI by day-bootstrap
- pre-open → same day (reads news) n=2359
    dir   +0.103 [+0.068, +0.140]
    good  +0.091 [+0.055, +0.125]
    flip  +0.108 [+0.075, +0.141]
    kw    +0.080 [+0.041, +0.116]
- pre-open, rel>0.5 n=1340
    dir   +0.153 [+0.102, +0.205]
    good  +0.149 [+0.097, +0.197]
    flip  +0.147 [+0.101, +0.192]
    kw    +0.122 [+0.071, +0.180]
- intraday → next day (tradable drift) n=1554
    dir   -0.006 [-0.046, +0.041]
    good  -0.024 [-0.063, +0.019]
    flip  -0.017 [-0.055, +0.031]
    kw    -0.033 [-0.073, +0.009]
    open→close (tradable after pre-open news), dir: -0.032 [-0.069, +0.009]  kw: -0.022 [-0.056, +0.011]
- ticker-day (pre-open, relevant) n=1006: dir +0.111 [+0.058, +0.173]  kw +0.111 [+0.059, +0.164]  long-short abn (dir>0.3 vs < -0.3): +0.012 [+0.004, +0.018]

## Materiality: AUC for |move| > 2σ on the ticker-day (0.5 = coin flip)
  P(material) max +0.649 [+0.580, +0.714]   news-count baseline +0.614 [+0.554, +0.683]   base rate 0.073

## Pre-open alert: relevant + bad + material (put-seller's 6:30 am flag) → share of days the stock falls > 1σ vs SPY
  openjev rel&bad&mat > .5     days   22  P(z<-1) 0.45  (all pre-open days 0.13)  mean z -0.94
  openjev rel&bad > .5         days  259  P(z<-1) 0.22  (all pre-open days 0.13)  mean z -0.27
  keyword negative (kw < 0)    days  223  P(z<-1) 0.21  (all pre-open days 0.13)  mean z -0.22

## Relevance gate: P(rel) vs keyword 'market roundup'
  mean P(rel): market-roundup headlines 0.26  others 0.55

## Event type: agreement with keyword rules (where a rule fires) + what moves
  agree 1149/1923
  earnings  n= 316  P(|z|>2) 0.22  mean|z| 1.42  dir-IC +0.21
  analyst   n= 354  P(|z|>2) 0.05  mean|z| 0.76  dir-IC +0.14
  deal      n= 151  P(|z|>2) 0.08  mean|z| 0.96  dir-IC +0.18
  product   n= 156  P(|z|>2) 0.03  mean|z| 0.76  dir-IC +0.03
  legal     n=  16  P(|z|>2) 0.12  mean|z| 1.00  dir-IC +0.70
  capital   n=  23  P(|z|>2) 0.00  mean|z| 0.65  dir-IC +0.28
  people    n=  65  P(|z|>2) 0.05  mean|z| 0.79  dir-IC -0.12
  market    n=1142  P(|z|>2) 0.08  mean|z| 0.87  dir-IC +0.07
  other     n= 136  P(|z|>2) 0.07  mean|z| 0.75  dir-IC +0.03

## By cap tier (0 small … 2 large), pre-open dir IC
  tier 0 n=930 dir +0.123 kw +0.083
  tier 1 n=722 dir +0.050 kw +0.065
  tier 2 n=707 dir +0.118 kw +0.088

## Calibration of P(good) on pre-open, relevant: realized share of up-days (abn > 0)
  P(good) 0.0–0.1: n= 660 up-share 0.43
  P(good) 0.1–0.4: n=  64 up-share 0.45
  P(good) 0.4–0.6: n=  20 up-share 0.50
  P(good) 0.6–0.9: n=  42 up-share 0.50
  P(good) 0.9–1.0: n= 554 up-share 0.49

pre IC(dir) - IC(kw): +0.023 [-0.015, +0.057]
pre IC(combo) - IC(kw): +0.022 [-0.005, +0.046]
pre kw silent n=1707 IC(dir): +0.054 [+0.016, +0.094]
pre rel IC(dir) - IC(kw): +0.030 [-0.017, +0.076]
pre rel IC(combo) - IC(kw): +0.030 [-0.002, +0.061]
pre rel kw silent n=927 IC(dir): +0.092 [+0.035, +0.146]
AUC mat - count: +0.035 [-0.028, +0.092]
AUC combo - count: +0.039 [-0.013, +0.080] combo +0.653 [+0.582, +0.717]
```
