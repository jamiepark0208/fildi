# S206 — paired structure choice per idea (A192 V4, Claude 11-24)
Question (Jamie 11-23/24): can Fildi pick the best structure per idea, not just sell puts? V4 gate: a signal-conditioned scenario set must beat the no-view board policy and every fixed selector on held-out trades. Script: scripts/watchlist_sync/analysis/s206_structure_choice.py (pre-registration in its docstring). Raw output: scripts/watchlist_sync/out/opt/S206.md.

**Literature:** Coval & Shumway 2001 (option returns ≈ leveraged beta, calls carry negative alpha vs stock) · Goyal & Saretto 2009 (IV−RV gap predicts option returns, survives costs) → expect structure choice to add value only through vol pricing or a real drift, not through relabelling the same drift.

**Verdict: RULE NO-LIFT (pre-registered).** Bull cell (45 months, 1,303 trades, cash lens): s100-conditioned choice +29.3 %/30 d vs no-view +21.2 (gap +8.1 pt, t 0.8), always long call +35.3 (s100 trails by −6.0, t −1.0), stock +4.6, short put +1.5 (t 6.0, worst-5 % −13.5 %). Placebo (random non-signal episodes) +34.5 % — BEATS the S100 pool (t −2.4 for s100 − placebo): any real momentum-era drift does the work, not the signal. Holdout ≥ 2024-07 sign differs. Independent events = month blocks (52; bull 45). Bear cell < 30 months → UNDERPOWERED (Data checked: LSEG 2020-09→2026-10, longest panel; bear 7 months).
**So-what:** for an S100 idea, "always the 0.50Δ 30-day call" is already as good as any model choice we can build; the model's extra picks (cash 262×, put spread 247×) give up return. Short put = the low-variance arm (t 6.0, +1.5 %/30 d on cash), not the high-return one. V5 keeps showing alternatives, no "best" badge.

**Data checked:** lseg_research.daily_history (closes + iv30 put/call, 2020-09 → 2026-10, 224 tickers incl. SPY) · optlab.lseg_opt_daily (real quotes → Pricer ratios) · lseg_research.earnings_moves (exact report dates) · FRED DTB3 · S100 panel 3,840 entries 2020-02 → 2026-09 → 1,910 episodes → 1,615 walk-forward trades, 52 months (bull 45, bear 7: longest panel available; bear needs ≥ 23 more bear months).

## Winner pass
Winners (train era < 2024-07, bull): the trades where the s100 selector beat always-long-call are its cash picks in months the call lost (stock fell after entry); losers = its put-spread / cash picks in months the call paid +100 %+. Pre-entry pattern: the conditioned pool's z distribution has a fat right tail, but its EV ÷ debit still sits below the T-bill when IV is high (iv30 rich vs rv20) → the selector goes to cash exactly when calls are expensive, and expensive calls still won in 2021/2023/2025 momentum names. Next rule to test: choice by IV-cheapness ramp (S177 / Goyal-Saretto) inside S100 ideas, call vs stock only, same harness — not a scenario EV.

Contract: 1–7 ok · 8 model_calibrated (no 2021–26 chains) · 13 missing (daily closes) · 20 today's names (relative comparisons only).

## all: 1615 trades · 52 months
**cash lens** (realized pnl ÷ cash tied up, month-mean, 30 d)
| selector | mean | t | s100 − this (t) | worst-5 % trade |
|---|---|---|---|---|
| s100 | +19.28 % | 2.3 |  | -100.0 % |
| no_view | +13.95 % | 1.8 | +5.33 pt (0.7) | -100.0 % |
| placebo | +23.95 % | 2.6 | -4.67 pt (-1.9) | -100.0 % |
| stock | +3.49 % | 2.6 | +15.79 pt (2.1) | -31.5 % |
| long_call | +22.65 % | 1.9 | -3.37 pt (-0.6) | -100.0 % |
| call_spread | +10.87 % | 1.2 | +8.42 pt (1.3) | -100.0 % |
| short_put | +1.47 % | 6.5 | +17.81 pt (2.1) | -13.9 % |
| put_spread | +2.14 % | 1.2 | +17.15 pt (2.2) | -100.0 % |
picks s100: {'long_call': 703, 'cash': 409, 'put_spread': 283, 'short_put': 170, 'stock': 50} · no_view: {'long_call': 878, 'short_put': 300, 'put_spread': 281, 'cash': 105, 'call_spread': 51}

**finite_loss lens** (realized pnl ÷ max loss, month-mean, 30 d)
| selector | mean | t | s100 − this (t) | worst-5 % trade |
|---|---|---|---|---|
| s100 | +19.22 % | 2.3 |  | -100.0 % |
| no_view | +13.94 % | 1.8 | +5.28 pt (0.7) | -100.0 % |
| placebo | +23.89 % | 2.6 | -4.67 pt (-1.9) | -100.0 % |
| stock | +3.49 % | 2.6 | +15.74 pt (2.1) | -31.5 % |
| long_call | +22.65 % | 1.9 | -3.43 pt (-0.6) | -100.0 % |
| call_spread | +10.87 % | 1.2 | +8.36 pt (1.3) | -100.0 % |
| short_put | +1.54 % | 6.6 | +17.68 pt (2.1) | -14.4 % |
| put_spread | +2.14 % | 1.2 | +17.09 pt (2.2) | -100.0 % |
picks s100: {'long_call': 703, 'cash': 409, 'put_spread': 279, 'short_put': 174, 'stock': 50} · no_view: {'long_call': 878, 'short_put': 303, 'put_spread': 278, 'cash': 105, 'call_spread': 51}

## bull: 1303 trades · 45 months
**cash lens** (realized pnl ÷ cash tied up, month-mean, 30 d)
| selector | mean | t | s100 − this (t) | worst-5 % trade |
|---|---|---|---|---|
| s100 | +29.30 % | 2.0 |  | -100.0 % |
| no_view | +21.18 % | 2.0 | +8.12 pt (0.8) | -100.0 % |
| placebo | +34.45 % | 2.3 | -5.15 pt (-2.4) | -100.0 % |
| stock | +4.55 % | 2.8 | +24.76 pt (1.8) | -31.5 % |
| long_call | +35.31 % | 2.1 | -6.01 pt (-1.0) | -100.0 % |
| call_spread | +15.62 % | 1.5 | +13.69 pt (1.4) | -100.0 % |
| short_put | +1.50 % | 6.0 | +27.81 pt (1.9) | -13.5 % |
| put_spread | +2.02 % | 1.1 | +27.28 pt (1.9) | -100.0 % |
picks s100: {'long_call': 612, 'cash': 262, 'put_spread': 247, 'short_put': 134, 'stock': 48} · no_view: {'long_call': 776, 'short_put': 219, 'put_spread': 198, 'cash': 72, 'call_spread': 38}

**finite_loss lens** (realized pnl ÷ max loss, month-mean, 30 d)
| selector | mean | t | s100 − this (t) | worst-5 % trade |
|---|---|---|---|---|
| s100 | +29.27 % | 2.0 |  | -100.0 % |
| no_view | +21.15 % | 2.0 | +8.11 pt (0.8) | -100.0 % |
| placebo | +34.42 % | 2.3 | -5.15 pt (-2.4) | -100.0 % |
| stock | +4.55 % | 2.8 | +24.72 pt (1.8) | -31.5 % |
| long_call | +35.31 % | 2.1 | -6.04 pt (-1.0) | -100.0 % |
| call_spread | +15.62 % | 1.5 | +13.65 pt (1.4) | -100.0 % |
| short_put | +1.57 % | 6.0 | +27.69 pt (1.9) | -14.1 % |
| put_spread | +2.02 % | 1.1 | +27.24 pt (1.9) | -100.0 % |
picks s100: {'long_call': 612, 'cash': 262, 'put_spread': 244, 'short_put': 137, 'stock': 48} · no_view: {'long_call': 776, 'short_put': 221, 'put_spread': 196, 'cash': 72, 'call_spread': 38}

