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
| StarMine alpha / ARM / credit, analyst price-target upside | Fundamentals: expectations / safety | live; dup in Model List STREET/OWN and tech v4 analystUpside | alpha t 0.9 here, t 2.1 in Step 8: keep, don't raise |
| Value, growth, quality, safety metrics | Fundamentals | live | not testable yet (needs filed-date history, F2) |
| Breadth (median stock vs 52w high), SPY VRP, VIX level, index trend, macro cycle | Market regime dial | owner = Claude (A26); plan: PLAN_next_session.md | rich VRP: 19% vs 28% breaches; trend off in selloffs |
| Strategy weights, verdicts, sizing, covered-call guard (20d relative strength) | Model List | live / proposed (M1, M2) | calls: −20d vs SPY IC +0.040, t 2.4 |
