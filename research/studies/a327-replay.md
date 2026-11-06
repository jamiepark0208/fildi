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
