# S151 Phase 4 — AFML re-grade (A341 P4)

N=1050 cells = evaluated grid on 2023–24 check window (signal×instrument Δ×entry×exit×tier; 21 signal ids; bars_5m excluded; n_sig≥30)

PBO matrix (2023–26 monthly excess): **N=1050** cells in grid; **0** dropped (fewer than 12 finite months).
N_eff (participation ratio on cell correlation): **20.54** (DSR n_trials = round N_eff = 21).
Cross-check: average linkage on 1−r, cut at correlation 0.5 → **52** clusters.

Study-level PBO (CSCV-16, all N cells monthly excess, 2023–26 window): **0.054**

Pass bar (verdict uses DSR@N_eff): DSR≥0.95 AND PBO<0.5 AND ≥4/5 purged month-folds same-sign excess **in both windows**; n_months<24 → underpowered (n_months shown per row).

Caveat: universe = current LSEG names; survivorship biases put breach rates downward (survivors flatter short puts).

| signal | window | n_months | N | DSR@1050 | DSR@N_eff | DSR@K | PBO | folds same-sign | old | new |
|---|---|---:|---:|---:|---:|---:|---:|---:|---|---|
| SPY RSI-14 Q1 + up_climax | 2023-26 | 21 | 1050 | 0.937 | 1.000 | 0.999 | 0.054 | 5/5 | PASS | underpowered |
| IV÷RV Q1 + up_climax | 2023-26 | 45 | 1050 | 0.856 | 0.973 | 0.955 | 0.054 | 5/5 | PASS | survives |
| SPY RSI-14 Q1 + up_climax | 2018-22 | 20 | 1050 | 0.608 | 0.962 | 0.914 | 0.054 | 5/5 | PASS | underpowered |
| IV÷RV Q1 + up_climax | 2018-22 | 28 | 1050 | 0.121 | 0.457 | 0.345 | 0.054 | 4/5 | PASS | downgraded:DSR |

**Overall (both windows):**
- SPY RSI-14 Q1 + up_climax: **underpowered (window; n_months 2023-26=21, 2018-22=20)**
- IV÷RV Q1 + up_climax: **downgraded (downgraded:DSR)**

**Placebo** (shuffle signal dates within ticker-month, 2023–26):
- SPY RSI-14 Q1 + up_climax: 3/20 seeds DSR≥0.95 (n_trials=N_eff round)
- IV÷RV Q1 + up_climax: 11/20 seeds DSR≥0.95 (n_trials=N_eff round)

Runtime: 470.2s · Agent: cursor · Refs: A341
