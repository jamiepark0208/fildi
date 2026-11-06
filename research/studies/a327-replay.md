# A327 replay (learning loop v2)

Weeks simulated: 304 (2021-01-04 → 2026-10-27)

## Rules

| status | rules |
|---|---|
| kept | band_engine, put_edge_q5, rich_puts |
| demoted | iv_rv_gate |

## Demotions (first event per rule)

- **iv_rv_gate** @ 2025-03-31 (posterior_floor)

Promotions: 0 (≤ 1/month target)

Months with a proposed move: 57 · confirmed 2 cycles: 56 · max P(better) 0.5867722642099907

- 2022-02-07: street.k 8.0→6.0 · confirmed 0 · P None
- 2022-03-07: premium.w_iv_rv 0.7→0.875; street.k 8.0→6.0 · confirmed 1 · P 0.077
- 2022-04-04: street.k 8.0→6.0 · confirmed 1 · P 0.5
- 2022-05-02: street.k 8.0→6.0 · confirmed 1 · P 0.5
- 2022-06-06: street.k 8.0→6.0 · confirmed 1 · P 0.5
- 2022-07-04: street.k 8.0→6.0 · confirmed 1 · P 0.5
- 2022-08-01: street.k 8.0→6.0 · confirmed 1 · P 0.5
- 2022-09-05: street.k 8.0→6.0 · confirmed 1 · P 0.5
- 2022-10-03: street.k 8.0→6.0 · confirmed 1 · P 0.5
- 2022-11-07: premium.w_iv_rv 0.7→0.5858; premium.w_iv_rank 0.3→0.375; street.k 8.0→6.0 · confirmed 1 · P 0.154
- 2022-12-05: premium.w_iv_rv 0.7→0.5834; premium.w_iv_rank 0.3→0.375; street.k 8.0→6.0 · confirmed 3 · P 0.164
- 2023-01-02: premium.w_iv_rv 0.7→0.5834; premium.w_iv_rank 0.3→0.375; street.k 8.0→6.0 · confirmed 3 · P 0.193
- 2023-02-06: premium.w_iv_rv 0.7→0.5909; premium.w_iv_rank 0.3→0.375; street.k 8.0→6.0 · confirmed 3 · P 0.198
- 2023-03-06: premium.w_iv_rv 0.7→0.5791; premium.w_iv_rank 0.3→0.375; street.k 8.0→6.0 · confirmed 3 · P 0.165
- 2023-04-03: premium.w_iv_rv 0.7→0.5791; premium.w_iv_rank 0.3→0.375; street.k 8.0→6.0 · confirmed 3 · P 0.15
- 2023-05-01: premium.w_iv_rv 0.7→0.5709; premium.w_iv_rank 0.3→0.375; street.k 8.0→6.0 · confirmed 3 · P 0.155
- 2023-06-05: premium.w_iv_rv 0.7→0.5749; premium.w_iv_rank 0.3→0.375; street.k 8.0→6.0 · confirmed 3 · P 0.178
- 2023-07-03: premium.w_iv_rv 0.7→0.5749; premium.w_iv_rank 0.3→0.375; street.k 8.0→6.0 · confirmed 3 · P 0.187
- 2023-08-07: premium.w_iv_rv 0.7→0.6044; premium.w_iv_rank 0.3→0.375; street.k 8.0→6.0 · confirmed 3 · P 0.183
- 2023-09-04: premium.w_iv_rv 0.7→0.6; premium.w_iv_rank 0.3→0.375; street.k 8.0→6.0 · confirmed 3 · P 0.166
- 2023-10-02: premium.w_iv_rv 0.7→0.6; premium.w_iv_rank 0.3→0.375; street.k 8.0→6.0 · confirmed 3 · P 0.133
- 2023-11-06: premium.w_iv_rv 0.7→0.616; premium.w_iv_rank 0.3→0.375; street.k 8.0→6.3777 · confirmed 3 · P 0.134
- 2023-12-04: premium.w_iv_rv 0.7→0.5756; premium.w_iv_rank 0.3→0.375; street.k 8.0→6.7168 · confirmed 3 · P 0.143
- 2024-01-01: premium.w_iv_rv 0.7→0.5756; premium.w_iv_rank 0.3→0.375; street.k 8.0→6.7168 · confirmed 3 · P 0.163
- 2024-02-05: premium.w_iv_rv 0.7→0.6112; premium.w_iv_rank 0.3→0.375; street.k 8.0→7.7805 · confirmed 3 · P 0.171
- 2024-03-04: premium.w_iv_rv 0.7→0.6072; premium.w_iv_rank 0.3→0.375; street.k 8.0→8.1966 · confirmed 2 · P 0.173
- 2024-04-01: premium.w_iv_rv 0.7→0.6072; premium.w_iv_rank 0.3→0.375; street.k 8.0→8.1966 · confirmed 3 · P 0.178
- 2024-05-06: premium.w_iv_rv 0.7→0.6099; premium.w_iv_rank 0.3→0.375; street.k 8.0→8.4702 · confirmed 3 · P 0.177
- 2024-06-03: premium.w_iv_rv 0.7→0.6099; premium.w_iv_rank 0.3→0.375; street.k 8.0→8.4702 · confirmed 3 · P 0.181
- 2024-07-01: premium.w_iv_rv 0.7→0.6099; premium.w_iv_rank 0.3→0.375; street.k 8.0→8.3778 · confirmed 3 · P 0.215
- 2024-08-05: premium.w_iv_rv 0.7→0.6148; premium.w_iv_rank 0.3→0.375; street.k 8.0→8.1643 · confirmed 3 · P 0.273
- 2024-09-02: premium.w_iv_rv 0.7→0.6148; premium.w_iv_rank 0.3→0.375; street.k 8.0→8.1643 · confirmed 3 · P 0.281
- 2024-10-07: premium.w_iv_rv 0.7→0.6186; premium.w_iv_rank 0.3→0.375; street.k 8.0→7.7654 · confirmed 2 · P 0.262
- 2024-11-04: premium.w_iv_rv 0.7→0.6289; premium.w_iv_rank 0.3→0.3711; street.k 8.0→7.7699 · confirmed 3 · P 0.353
- 2024-12-02: premium.w_iv_rv 0.7→0.6289; premium.w_iv_rank 0.3→0.3711; street.k 8.0→7.7699 · confirmed 3 · P 0.351
- 2025-01-06: premium.w_iv_rv 0.7→0.6199; premium.w_iv_rank 0.3→0.375; street.k 8.0→7.5305 · confirmed 3 · P 0.289
- 2025-02-03: premium.w_iv_rv 0.7→0.6199; premium.w_iv_rank 0.3→0.375; street.k 8.0→7.5305 · confirmed 3 · P 0.357
- 2025-03-03: premium.w_iv_rv 0.7→0.6171; premium.w_iv_rank 0.3→0.375; street.k 8.0→7.2377 · confirmed 3 · P 0.38
- 2025-04-07: premium.w_iv_rv 0.7→0.6052; premium.w_iv_rank 0.3→0.375; street.k 8.0→7.2953 · confirmed 3 · P 0.234
- 2025-05-05: premium.w_iv_rv 0.7→0.5933; premium.w_iv_rank 0.3→0.375; street.k 8.0→7.4272 · confirmed 3 · P 0.231

## Per-rule posteriors @ replay end

| rule | live weeks | P&L/wk bp (post) | floor bp | P(below floor) |
|---|---:|---:|---:|---:|
| put_edge_q5 | 299 | +21.3 | 15 | 0.000 |
| iv_rv_gate | 299 | +5.7 | 10 | 0.946 |
| band_engine | 303 | +23.4 | 8 | 0.000 |
| rich_puts | 114 | +93.5 | 45 | 0.021 |
| sector_drop_relax | 0 | +0.0 | 20 | 1.000 |

**Hand-check iv_rv_gate @ 2025-03-31:** live weeks 221, posterior P&L/wk +3.4 bp vs floor 10 bp, P(below floor)=0.9826

## Acceptance

- i_q5_kept: **pass**
- ii_demotion_path: **pass**
- iii_promo_monthly: **pass**
- iv_weight_converge: **pass**

## Weight path σ (first 12 mo vs last 12 mo)

| weight | σ first | σ last |
|---|---|---|

First monthly snapshot (2021-01-04): contract_iv_pre_earnings=0.0000, w_iv_level=0.0000, w_iv_rank=0.3000, w_iv_rv=0.7000
Last monthly snapshot (2026-10-05): contract_iv_pre_earnings=0.0000, w_iv_level=0.0000, w_iv_rank=0.3000, w_iv_rv=0.7000

| contract_iv_pre_earnings | 0.0000 | 0.0000 | last mo [False, False, False]
| w_iv_level | 0.0000 | 0.0000 | last mo [0.0, 0.0, 0.0]
| w_iv_rank | 0.0000 | 0.0000 | last mo [0.3, 0.3, 0.3]
| w_iv_rv | 0.0000 | 0.0000 | last mo [0.7, 0.7, 0.7]
