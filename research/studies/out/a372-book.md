# A372 book layer (S047 replay + stress)

CONTRACT 1-7: same-job item 2 only. Comparator = equal notional IRA replay. vol_scaled TARGET_ATR=0.025 (# global: pending stock-own table). corr cap |ρ|≥0.7 on 126d log returns → ×0.5. Stress = modelled S045 weekly puts (not Jamie fills). Survivorship: today's names.

IRA settled 396 trades · 2026-01-01→ · bars lseg_research.daily_history · ATR quantcore.ta

| policy | n | weeks | total ret | mean bp/wk | max DD | CVaR 5% wk | worst month |
|---|---:|---:|---:|---:|---:|---:|---:|
| equal | 396 | 35 | +24.2% | +62.4 | -2.2% | -1.23% | -1.28% |
| vol_scaled | 396 | 35 | +21.3% | +55.6 | -3.2% | -1.59% | -1.86% |
| corr_cap | 396 | 35 | +24.4% | +62.7 | -2.2% | -1.23% | -1.28% |

Stress windows (concurrent top-8 modelled puts / week):

**2020-03**
- equal: n=80 mean -43.0 bp/trade · modelled_weekly_puts
- vol_scaled: n=80 mean -34.2 bp/trade · modelled_weekly_puts
- corr_cap: n=80 mean -43.0 bp/trade · modelled_weekly_puts

**2022-H1**
- equal: n=240 mean +18.8 bp/trade · modelled_weekly_puts
- vol_scaled: n=240 mean +12.0 bp/trade · modelled_weekly_puts
- corr_cap: n=240 mean +18.8 bp/trade · modelled_weekly_puts

## Winner pass
Winners = positive pnl IRA puts; losers assigned or closed underwater. Next rule to test: cluster cap on stress VaR (S140) with same vol scale.
RULE NO-LIFT: vol_scaled sizing × hold-to-expiry × IRA book — mean/tail do not beat equal at n=396.
Verdict: **NO-LIFT** (n_weeks=35; calm 2026 sample; stress is modelled).
