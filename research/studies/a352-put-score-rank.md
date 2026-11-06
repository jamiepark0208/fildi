# A352 put-score rank

Window 2021-01-04 → 2026-10-27. Rebuilt option_score from entry-date IV, IV/RV, tech total, premium and 1σ strike.
Scored puts 62644. Weeks with ≥20 names: 299 (stop bar 150).
Rank IC is the within-week Spearman, averaged across weeks. 90% CI resamples weeks.

| target | weeks | IC mean [90% CI] | call |
|---|---|---|---|
| stock excess, raw score | 299 | -0.0295 [-0.0573, -0.0028] | inverted |
| stock excess, IV-neutral | 299 | +0.0058 [-0.0101, +0.0206] | inconclusive |
| put P&L % strike, raw score | 299 | +0.6841 [+0.6639, +0.7045] | pass |
| put P&L % strike, IV-neutral | 299 | +0.3092 [+0.2951, +0.3240] | pass |

Pass bar is the IV-neutral put-P&L IC: **pass**. Stock-excess IV-neutral: **inconclusive**. Raw stock-excess: **inverted**.
Mechanics check, not the pass bar: Pearson(score residual, strike IV) +0.0000 [-0.0000, +0.0000] (about 0 means the residual has no linear IV). Strike IV vs put P&L +0.7801 [+0.7570, +0.8013]. Strike IV vs stock excess -0.0385 [-0.0699, -0.0070].

Challenger = IV-residual score, ≤2 names per co-movement group. Champion = raw score, same count. Random = same-delta (the 1σ put) same week. T-bill = FRED DTB3 over the hold.
Level, bp of strike per week: challenger -0.1 · champion +11.8 · random +0.2 · T-bill +3.5 · n 299 weeks.
Paired challenger − champion: -12.0 bp [-15.8, -8.2] · better 73/299 weeks. P(challenger mean > champion) 0.31.
Paired challenger − random: -0.3 bp [-2.9, +2.4] · better 147/299 weeks. P(challenger mean > random) 0.49.
Paired challenger − T-bill: -3.6 bp [-10.7, +2.4] · better 196/299 weeks.

Live scores were not changed.

Known weaknesses: income uses the mid 1σ premium, not a live bid; regime fixed at BASELINE; support, fund total, and the 7-day earnings haircut are not on the stored lab row; co-movement groups are today's membership.
