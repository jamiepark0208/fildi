# A314 family 2 — breadth & internals intraday

- **breadth_thrust** · ≥10pp 30m rise % above open → lower drop risk · effect +10.0/+9.4pp · t +5.2/+4.0 · MDE≈4.2pp @ n=332 · **FAIL** · Zweig thrust / McClellan (intraday)
- **spy_breadth_div** · SPY up, breadth down → higher drop risk · effect +6.7/+6.8pp · t +2.5/+2.9 · MDE≈5.0pp @ n=238 · **PASS intraday** · McClellan divergence vs index
- **vwap_roc_fall** · ≥8pp 30m drop % above VWAP → higher drop risk · effect +1.9/+2.5pp · t +1.6/+2.2 · MDE≈2.3pp @ n=472 · **FAIL** · NYSE ADD / % above VWAP ROC
- **up_vol_ratio_low** · Up-volume ratio <48% → higher drop risk · effect -1.3/-2.1pp · t -2.7/-4.3 · MDE≈0.9pp @ n=477 · **FAIL** · Up-volume ratio / TICK

## Put benchmark (prior session event → skip entry week)

- **put skip prior `spy_breadth_div`** · book +24.2 bp · Δ -5.4 · t -2.6 · pre-2023 Δ +0.0 · **WORSE**

## Live subset gate (VWAP drop ≥8pp / 30m, logit dropx ~ S126 score + event, day-clustered t)

| N | seed | H1 t | H2 t | pass |
|---:|---:|---:|---:|---|
| 160+ | full | +5.0 | +4.0 | yes |

Subset rows (N=20/40/80 × seeds 0–2): run `analysis/a314_breadth_gate_fast.py` (rebuilds `above_vwap` from `optlab.bars_5m`); **Live ships N=20** top-liquid tickers in `A314-breadth-live-tickers.json` (Schwab lane, 0 extra vendor calls).
