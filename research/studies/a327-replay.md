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

## Acceptance

- i_q5_kept: **pass**
- ii_rich_demoted: **fail**
- iii_promo_monthly: **pass**
- iv_weight_converge: **pass**

## Weight path σ (first 12 mo vs last 12 mo)

| weight | σ first | σ last |
|---|---|---|
| contract_iv_pre_earnings | 0.0000 | 0.0000 |
| w_iv_level | 0.0000 | 0.0000 |
| w_iv_rank | 0.0000 | 0.0000 |
| w_iv_rv | 0.0000 | 0.0000 |
