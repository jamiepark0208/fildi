# Learning cycle 2026-10-05: challenger fit-1.4.1 (parent fit-1.4.0)

## Proposed changes

| param | old | new | why |
|---|---|---|---|
| premium.w_iv_rv | 0.7 | 0.673 | premium-kept IC +0.041 → target share 0.67 |
| premium.w_iv_rank | 0.3 | 0.327 | premium-kept IC +0.020 → target share 0.33 |
| street.k | 8.0 | 10.0 | StarMine alpha own-target IC | IV +0.038 (t +3.8) → scale 1.26 |
| severity.falling_knife | 0.2 | 0.15 | flag doesn't hurt put outcomes (tail -0.6 pts t -1.2; risk-adj return t +2.2) |

## Before vs after (scenario on today's inputs)

**1 verdict changes** on the latest inputs (264 names):

| from → to | n | tickers |
|---|---|---|
| none → yellow | 1 | HOOD |

Live evidence: 0 non-data grades (data-error grades excluded: 0).

Next: fit-1.4.1 is scored in shadow beside fit-1.4.0 every day (fit_model_v14). Promote with `learn.py promote fit-1.4.1 --approve`, or retire it.
