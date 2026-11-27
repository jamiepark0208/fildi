# A373 packet (≤20 lines)

CONTRACT 1-7: ok (items 1–2 stock/vol; item 3 ops; item 4 UI)
SURVIVORSHIP: today's LSEG panel (A356-class); stock legs only in items 1–2

**Item 3 (TV indicators):** PASS — `analysis/a373_tv_indicator_test.py` 12/12 (EMA SMA-seed, Wilder RSI, pop-σ BB, SuperTrend sign).

**Item 1 macro pillar:** FAIL — top-IV VRP vs week peers; macro high t=−1.12 (H1 +1.55 / H2 −1.74 sign flip). Not marginal vs breadth (<40% below200 t≈0). Data: Yahoo RSP/HYG/LQD/TLT + LSEG; 10Y−5Y = ^TNX−^FVX (# global: FRED timeout). `a373_macro_pillar.py`.

**Item 2 three-pillar fast screen:** FAIL for ship — RE_ENTRY 5d excess t=+6.38 (120 names, 5d step) but macro omitted per-ticker; EXIT_TRIM/WAIT negative. No call lane / no leak-placebo. S004-class duplicate. `a373_three_pillar.py`.

**Item 4 invalidation:** Ideas + Model List cards show "Wrong if …" (API `ideaFalsifier` + contract-derived model list line).

Refs: A373 · Agent: cursor