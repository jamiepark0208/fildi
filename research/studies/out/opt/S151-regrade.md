# S151 Phase 4 — AFML re-grade (A341 P4)

N=1050 cells = evaluated grid on 2023–24 check window (signal×instrument Δ×entry×exit×tier; 21 signal ids; bars_5m excluded; n_sig≥30)

Study-level PBO (CSCV-16, all N cells monthly excess, 2023–26 window): **0.054**

Pass bar: DSR≥0.95 AND PBO<0.5 AND ≥4/5 purged month-folds same-sign excess **in both windows**; n_months<24 → underpowered.

| signal | window | N | DSR | PBO | folds same-sign | old | new |
|---|---|---:|---:|---:|---:|---|---|
| SPY RSI-14 Q1 + up_climax | 2023-26 | 1050 | 0.937 | 0.054 | 5/5 | PASS | underpowered |
| IV÷RV Q1 + up_climax | 2023-26 | 1050 | 0.856 | 0.054 | 5/5 | PASS | downgraded:DSR |
| SPY RSI-14 Q1 + up_climax | 2018-22 | 1050 | 0.608 | 0.054 | 5/5 | PASS | underpowered |
| IV÷RV Q1 + up_climax | 2018-22 | 1050 | 0.121 | 0.054 | 4/5 | PASS | downgraded:DSR |

**Overall (both windows):**
- SPY RSI-14 Q1 + up_climax: **underpowered (window)**
- IV÷RV Q1 + up_climax: **downgraded (downgraded:DSR)**

**Placebo** (shuffle signal dates within ticker-month, 2023–26):
- SPY RSI-14 Q1 + up_climax: 0/20 seeds DSR≥0.95
- IV÷RV Q1 + up_climax: 1/20 seeds DSR≥0.95

Runtime: 475.0s · Agent: cursor · Refs: A341
