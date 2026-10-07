# Scorecard lab PCA (2026-10-05)

20 components/features, monthly cross-sectional ranks, 17,990 rows. 7 PCs explain 85%.

| PC | var | top loadings | IC rel_21 | IC mae_z | IC rel_63 |
|---|---|---|---|---|---|
| PC1 | 23% | +v4p.relativePressure, +v2.trendContext, +v4p.trendContext, +v2.oversoldDepth | -0.009 | -0.004 | -0.009 |
| PC2 | 14% | +v4p.volatilityState, +f.iv_rv, +v2.volatilityState, −in.ivRankRvProxy | +0.010 | -0.007 | +0.003 |
| PC3 | 14% | +f.idio_vol, −f.dd_52w, −f.alpha, −f.mom_12_1 | -0.015 | +0.013 | -0.015 |
| PC4 | 11% | +v4p.reversalSignal, +v2.reversalSignal, −v2.volumeConfirm, −v4p.volumeConfirm | -0.024 | -0.027 | -0.014 |
| PC5 | 9% | +v4p.volumeConfirm, +v2.volumeConfirm, −f.dist_ma200, −f.mom_12_1 | -0.021 | -0.025 | -0.036 |
| PC6 | 7% | +f.mom_12_1, +f.beta, +f.idio_vol, +v2.reversalSignal | +0.006 | +0.002 | +0.021 |
| PC7 | 6% | +f.iv_rank_1y, +in.ivRankRvProxy, +v2.volatilityState, −f.iv_rv | -0.005 | -0.011 | +0.004 |

Highly overlapping pairs (|rank corr| ≥ 0.6) — candidates for consolidation:

- v2.oversoldDepth ↔ v2.trendContext: +0.76
- v2.oversoldDepth ↔ v4p.oversoldDepth: +0.89
- v2.oversoldDepth ↔ v4p.relativePressure: +0.78
- v2.oversoldDepth ↔ v4p.trendContext: +0.76
- v2.reversalSignal ↔ v4p.reversalSignal: +1.00
- v2.volatilityState ↔ v4p.volatilityState: +0.72
- v2.trendContext ↔ v4p.oversoldDepth: +0.67
- v2.trendContext ↔ v4p.relativePressure: +0.78
- v2.trendContext ↔ v4p.trendContext: +1.00
- v2.volumeConfirm ↔ v4p.volumeConfirm: +1.00
- v4p.oversoldDepth ↔ v4p.relativePressure: +0.69
- v4p.oversoldDepth ↔ v4p.trendContext: +0.67
- v4p.relativePressure ↔ v4p.trendContext: +0.78
- v4p.volatilityState ↔ f.iv_rv: +0.73
- f.mom_12_1 ↔ f.dist_ma200: +0.64
- f.dist_ma200 ↔ f.dd_52w: +0.73
- f.iv_rv ↔ in.ivRankRvProxy: -0.71
