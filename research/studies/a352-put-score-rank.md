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

## Follow-up 1

Same 299 weeks, bp of strike. 90% CI resamples weeks. Champion+cap = raw score, ≤2 names per co-movement group (IV stays in the score). CVaR5 = mean of the worst 15 weeks. Sortino = weekly mean / downside deviation below 0, times sqrt(52). Cash-secured = option P&L + that week's T-bill on collateral. Live scores unchanged.

Best cell: champion. Mean +11.8 bp, worst week -472.1, CVaR5 -283.4, Sortino 1.14. Champion+cap +6.8 / -532.2 / -217.9 / 0.81. Random +0.2 / -663.1 / -223.4 / 0.02. T-bill +3.5 / +0.0 / +0.0 / n/a. Champion leads mean and Sortino, and it has the least-bad worst week of the put books. Its CVaR5 is the worst of the four, so the high-score book carries the 5% tail. T-bill has no down week.

| cell | mean | worst week | CVaR5 | Sortino | cash mean | cash worst | cash CVaR5 | cash Sortino |
|---|---|---|---|---|---|---|---|---|
| champion | +11.8 | -472.1 | -283.4 | 1.14 | +15.3 | -472.0 | -280.6 | 1.49 |
| champion+cap | +6.8 | -532.2 | -217.9 | 0.81 | +10.3 | -527.6 | -215.6 | 1.25 |
| random | +0.2 | -663.1 | -223.4 | 0.02 | +3.7 | -658.5 | -220.8 | 0.43 |
| T-bill | +3.5 | +0.0 | +0.0 | n/a | +3.5 | +0.0 | +0.0 | n/a |

(a) champion − random: +11.6 bp [+7.3, +15.7] · better 223/299 weeks.
(c) champion+cap − champion: -5.0 bp [-8.3, -1.6] · better 88/299 weeks.
(e) Idle cash (no interest on collateral): champion − T-bill +8.3 bp [-0.2, +16.3] · better 219/299 weeks. Cash-secured (option P&L + T-bill on collateral) − T-bill +11.8 bp [+3.1, +20.2] · better 220/299 weeks. Week by week the cash-secured edge equals the option P&L, because the T-bill is earned either way. Cash-secured levels: champion +15.3, champion+cap +10.3, random +3.7, T-bill +3.5.
(d) Weeks the champion book's largest co-movement group fell more than 8% (equal-weight stock return to expiry): 28. Of those, 28 had more than 2 names in that group (the Oct-16 pile-up shape). This slice uses the realized hold return, so it is a stress cut, not an entry rule.
Crash slice n 28, mean group size 9.6, mean group stock return -11.1%. Champion -158.4 bp (worst -472.1, CVaR5 -447.2, Sortino -5.22). Champion+cap -111.4 bp (worst -532.2, CVaR5 -449.1, Sortino -4.63). Random -120.4. T-bill +2.3. Paired cap − champion: +46.9 bp [+25.0, +70.8] · better 23/28 weeks.

Live scores were not changed.

Known weaknesses: income uses the mid 1σ premium, not a live bid; regime fixed at BASELINE; support, fund total, and the 7-day earnings haircut are not on the stored lab row; co-movement groups are today's membership; the >8% group-drop slice is the realized hold, not a signal known at entry.
