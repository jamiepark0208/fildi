# A372 call exits (S046 lane)

CONTRACT 1-7: item 3 vs 5d hold. BS call r=0; indicators quantcore.ta; daily close only. Halves 2023-01-01. Comparator = hold. priced_by model (S046 harness). Year fraction: years_from_sessions (A421 fix; was years_from_days on session counts).

## A421 before → after (bp/wk)

| exit | before mean | after mean | Δ mean | before diff vs hold | after diff vs hold |
|---|---:|---:|---:|---:|---:|
| hold | -40.5 | -10.2 | +30.3 | +0.0 | +0.0 |
| rsi_turn | -37.4 | -9.0 | +28.4 | +3.1 | +1.2 |
| macd_shrink | -27.0 | -5.2 | +21.8 | +13.5 | +5.0 |
| ema20_break | -27.6 | -8.7 | +18.9 | +12.9 | +1.5 |
| any_atd | -8.8 | +14.6 | +23.4 | +31.7 | +24.8 |

any_atd−hold: +31.7 → +24.8 bp/wk (before → after).
**A421 verdict change:** macd_shrink and ema20_break were WORKS under /365; FAIL under /252 (t pre/post gates). any_atd still WORKS; S209 model-only fence unchanged.

n_events=125617 independent entry weeks=355 span 2020-02-03 → 2026-11-18

| exit | n | n_wk | mean bp/wk | hold | diff | t | t pre | t post | worst5 Δ bp | verdict |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|
| hold | 125617 | 355 | -10.2 | -10.2 | +0.0 | +nan | +nan | +nan | -496.8 | HOLD |
| rsi_turn | 125617 | 355 | -9.0 | -10.2 | +1.2 | +4.4 | +0.9 | +4.5 | -484.0 | FAIL |
| macd_shrink | 125617 | 355 | -5.2 | -10.2 | +5.0 | +9.2 | +1.6 | +9.4 | -386.3 | FAIL |
| ema20_break | 125617 | 355 | -8.7 | -10.2 | +1.5 | +0.1 | -4.2 | +2.3 | -357.1 | FAIL |
| any_atd | 125617 | 355 | +14.6 | -10.2 | +24.8 | +36.8 | +18.7 | +31.9 | -280.5 | WORKS |

## Winner pass
WORKS on any_atd at model prices — confirm on real call quotes before ship. Next: intraday exit minute + real call quotes (contract 13).
RULE LIFT: any_atd exit × cover call × S046 (model only).
Panel verdict: **any_atd** (priced_by=model; not for live without quote pass).
