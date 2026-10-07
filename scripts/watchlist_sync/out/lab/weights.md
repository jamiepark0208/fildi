# Weight variants: out-of-sample test (2026-10-05)

Variants were written down before running. Test years 2024–2026 (no fitting anywhere, so the whole span is out of sample; the held-out years guard against picking a variant that only fits 2020–23). Targets: 21d peer-relative return and 21d worst drop in σ units (mae_z). Paired t = Newey-West t of (variant IC − champion IC) month by month.

| variant | IC rel_21 all | IC rel_21 2024–26 | Δ vs champ (t) | IC mae_z 2024–26 | Δ vs champ (t) | verdict |
|---|---|---|---|---|---|---|
| champion v2 (live) | -0.009 | -0.015 | — | -0.010 | — | baseline |
| A: drop optionsFlow (no inputs in history or often live) | -0.009 | -0.015 | +0.000 (+nan) | -0.010 | +0.000 (+nan) | no sig. diff / no sig. diff |
| B: volatilityState uses true IV rank (LSEG) instead of RV proxy | -0.007 | -0.015 | -0.000 (-0.1) | -0.006 | +0.004 (+0.9) | no sig. diff / no sig. diff |
| C: + long-term trend component (12-1 mom, MA200) at 0.18 | +0.004 | +0.002 | +0.016 (+1.5) | -0.002 | +0.008 (+0.5) | no sig. diff / no sig. diff |
| D: B + C | +0.004 | +0.000 | +0.015 (+1.4) | +0.000 | +0.010 (+0.7) | no sig. diff / no sig. diff |
| E: oversold depth halved (0.25 → 0.125) | -0.012 | -0.017 | -0.003 (-0.6) | -0.022 | -0.012 (-1.6) | no sig. diff / no sig. diff |
