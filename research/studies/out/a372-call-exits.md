# A372 call exits (S046 lane)

CONTRACT 1-7: item 3 vs 5d hold. BS call r=0; indicators quantcore.ta; daily close only. Halves 2023-01-01. Comparator = hold. priced_by model (S046 harness).

n_events=79250 independent entry weeks=348 span 2020-02-03 → 2026-10-01

| exit | n | n_wk | mean bp/wk | hold | diff | t | t pre | t post | worst5 Δ bp | verdict |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|
| hold | 79250 | 348 | -11.7 | -11.7 | +0.0 | +nan | +nan | +nan | -496.8 | HOLD |
| rsi_turn | 79250 | 348 | -10.3 | -11.7 | +1.5 | +3.8 | +0.9 | +3.9 | -484.0 | FAIL |
| macd_shrink | 79250 | 348 | -6.0 | -11.7 | +5.7 | +8.9 | +1.6 | +9.3 | -386.3 | FAIL |
| ema20_break | 79250 | 348 | -9.8 | -11.7 | +2.0 | +3.2 | -4.2 | +6.3 | -357.1 | FAIL |
| any_atd | 79250 | 348 | +15.0 | -11.7 | +26.8 | +31.0 | +18.7 | +25.1 | -280.5 | WORKS |

## Winner pass
WORKS on any_atd at model prices — confirm on real call quotes before ship. Next: intraday exit minute + real call quotes (contract 13).
RULE LIFT: any_atd exit × cover call × S046 (model only).
Panel verdict: **any_atd** (priced_by=model; not for live without quote pass).
