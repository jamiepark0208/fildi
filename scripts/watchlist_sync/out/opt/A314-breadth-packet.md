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
| 214 | all | +6.0 | +4.9 | yes |
| 80 | 0/1/2 | +6.0/+5.1/+5.8 | +4.6/+4.4/+5.4 | yes |
| 40 | 0/1/2 | +5.1/+6.1/+6.4 | +3.5/+4.0/+4.4 | yes |
| 20 | 0/1/2 | +5.3/+3.4/+4.1 | +5.6/+4.8/+3.8 | yes |
| 19 config list | — | +4.6 | +4.8 | yes |
| 17 live (watchlist fallback) | — | +3.5 | +3.8 | yes |

(Claude 10-29: subset rows filled in.)

Subset rows (N=20/40/80 × seeds 0–2): run `analysis/a314_breadth_gate_fast.py` (rebuilds `above_vwap` from `optlab.bars_5m`); **Live ships N=20** top-liquid tickers in `A314-breadth-live-tickers.json` (Schwab lane, 0 extra vendor calls).
