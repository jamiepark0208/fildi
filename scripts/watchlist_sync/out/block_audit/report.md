# Block audit: verify outcomes graded at expiry

10 verified contracts have expired. Return = (realistic fill − intrinsic) ÷ collateral, as if sold and held.
Verdict needs ≥ 30 rows per group.

| group | rows | mean return | win rate | breach rate | worst | read |
|---|---|---|---|---|---|---|
| passed | 4 | +0.64% | 100% | 0% | +0.2% | too few rows |
| live_delta_band | 1 | +1.42% | 100% | 0% | +1.4% | too few rows |
| premium_realistic | 3 | +0.60% | 100% | 0% | +0.5% | too few rows |
| realistic_yield | 1 | +0.19% | 100% | 0% | +0.2% | too few rows |
| spread_ok | 4 | -0.07% | 75% | 25% | -1.8% | too few rows |
| still_otm | 1 | +1.42% | 100% | 0% | +1.4% | too few rows |

| plan | ticker | contract | blocks | return |
|---|---|---|---|---|
| 2 | ETSY | 70P 2026-10-09 | spread_ok, premium_realistic | +0.82% |
| 2 | HPQ | 31P 2026-10-09 | spread_ok | -1.81% |
| 2 | OXY | 56P 2026-10-09 | spread_ok, premium_realistic | +0.51% |
| 2 | POET | 8.5C 2026-10-09 | passed | +0.97% |
| 2 | RIG | 5P 2026-10-09 | passed | +0.82% |
| 2 | SOFI | 15P 2026-10-09 | premium_realistic | +0.47% |
| 3 | ETSY | 70P 2026-10-09 | still_otm, live_delta_band | +1.42% |
| 3 | OXY | 56P 2026-10-09 | spread_ok, realistic_yield | +0.19% |
| 3 | POET | 8.5C 2026-10-09 | passed | +0.57% |
| 3 | SOFI | 15P 2026-10-09 | passed | +0.21% |
