# A372 call exits (S046 lane)

CONTRACT 1-7: item 3 vs 5d hold. BS call r=0; indicators quantcore.ta; daily close only. Halves 2023-01-01. Comparator = hold. priced_by model (S046 harness).

n_events=79250 independent entry weeks=348 span 2020-02-03 → 2026-10-01

| exit | n | n_wk | mean bp/wk | hold | diff | t | t pre | t post | worst5 Δ bp | verdict |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|
| hold | 79250 | 348 | -40.5 | -40.5 | +0.0 | +nan | +nan | +nan | -531.7 | HOLD |
| rsi_turn | 79250 | 348 | -37.4 | -40.5 | +3.1 | +7.9 | +3.6 | +7.1 | -518.9 | FAIL |
| macd_shrink | 79250 | 348 | -27.0 | -40.5 | +13.5 | +19.9 | +11.1 | +16.7 | -415.5 | WORKS |
| ema20_break | 79250 | 348 | -27.6 | -40.5 | +12.9 | +18.7 | +8.9 | +16.5 | -368.7 | WORKS |
| any_atd | 79250 | 348 | -8.8 | -40.5 | +31.7 | +36.2 | +23.2 | +28.6 | -298.1 | WORKS |

## Winner pass
WORKS on macd_shrink, ema20_break, any_atd at model prices — confirm on real call quotes before ship. Next: intraday exit minute + real call quotes (contract 13).
RULE LIFT: any_atd exit × cover call × S046 (model only).
Panel verdict: **macd_shrink** (priced_by=model; not for live without quote pass).
