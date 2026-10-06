# Factor map: one home per factor (2026-10-05)

Rule: each factor lives in exactly one layer; scorecards are strategy-neutral (a claim about the stock or its options); strategy logic
lives only in the Model List. Check this file before proposing any new factor or score. Evidence: `out/lab/conclusions.md`, `out/step8/`.
Status: **live** = in that layer today · **proposed** = A25 deferred · **shipped** = A25 Cursor determination 10/05 · **dup** = also computed elsewhere today (to remove there).

| factor | home | status | evidence (lab, 2020–26) |
|---|---|---|---|
| Long-term trend: price vs MA200 (ATR units), 12-1 momentum | Technicals: TREND | proposed (T3) | IC +0.042, t 2.6 (63d vs peers); off in broad selloffs |
| Short-term: oversold depth, reversal, MA50 context, VWAP, volume, relative pressure | Technicals: entry timing (display, weight 0) | live, proposed demote (T4) | no edge, all \|t\| < 2 |
| Price risk: idio vol, beta | Technicals (risk) | proposed | sizes moves, not direction (raw-drop IC is mechanical) |
| Falling knife | Technicals (flag) | live | Step 4: no harm to put sellers; severity 0.15 in Model List |
| IV vs realized vol, IV rank (true LSEG history) | Options: PRICING | proposed (O1/O2); dup in tech Volatility State + Model List PREMIUM | VRP IC +0.137, t 10.1 |
| RV-proxy "ivRank", Bollinger squeeze | none (remove) | live in tech v2 | wrong-signed / no edge |
| Put/call ratio, skew, term structure | Options: PRICING | live in tech optionsFlow | untestable (no history) |
| Contract: income, buffer, delta, DTE, liquidity, earnings in window | Options: contract scoring | live | graded live (grade_ledger) |
| Analyst expectations: IBES revision breadth, estimate drift | Fundamentals: expectations | live | t 2.7 / 3.5, but redundant with trend (+0.008 when trend fixed) |
| IBES SUE (avg last 4), estimate dispersion | Fundamentals | live, proposed drop (F1) | no edge |
| Forward EPS growth (IBES FY1→FY2) | Fundamentals: expectations (`ibesFwdGrowth`, optional) | **live (fund-1.1.0)** | Lab IC +0.077–0.108 t ≥ 3.1; oftic-keyed; one-off FY1 jump null; no coverage shrink when IBES missing. Before/after rank corr 0.991, top-50 48 kept. `research/fair_value/FACTOR_STUDY.md` |
| 3-month consensus price-target revision | none (= trend) | rejected | IC +0.052 t 2.7 alone, but ρ 0.77 with price vs MA200; partial t 1.2: `research/fair_value/overlap_check.py` |
| StarMine alpha / ARM / credit, analyst price-target upside | Fundamentals: expectations / safety | live; dup in Model List STREET/OWN and tech v4 analystUpside | alpha t 0.9 here, t 2.1 in Step 8: keep, don't raise |
| Value, growth, quality, safety metrics | Fundamentals | live | not testable yet (needs filed-date history, F2) |
| Fair value (blended: peer/warranted P/E, Graham, Ohlson–Juettner, FCF DCF, EV/EBITDA, excess returns, P/FFO + de-biased target + StarMine) | Fundamentals: valuation reference (`lib/fair-value.ts`, display only) | live (fv-1.0.0) | gaps don't time returns; Model List shows strike vs fair (display). Cyclical max conf=medium (`cyclical_test.py` mid-cycle EPS avg rejected). Value-trap flag when cheap + weak 12-1 (hyp t 3.4). Method-spread stays in confidence only — not sizing. `research/fair_value/FINDINGS.md` |
| Value-trap (cheap + bottom-half 12-1 mom) | Fair-value badge / Explain (flag only) | live | H1: Graham-gap IC −0.128 bottom-half mom vs +0.024 top; Δ t 3.4 (`hypothesis_tests.py`) |
| Breadth (median stock vs 52w high), SPY VRP, VIX level, index trend, macro cycle | Market regime dial | owner = Claude (A26); plan: PLAN_next_session.md | rich VRP: 19% vs 28% breaches; trend off in selloffs |
| Strategy weights, verdicts, sizing, covered-call guard (20d relative strength) | Model List | live / proposed (M1, M2) | calls: −20d vs SPY IC +0.040, t 2.4 |
