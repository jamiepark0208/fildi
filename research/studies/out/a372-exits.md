# A372 exits vs hold-to-expiry

CONTRACT 1-7: missing 5 for roll |Δ|≥0.50 (19 filled trades before 2023-01, no t). Closes and roll |Δ|≥0.40 have both halves. Fill bid+23% / ask−23% (mid not used). Same trades, same span; DTB3 accrues on both sides and adds the same ~bp/wk. N_eff = entry weeks. Exit signal delayed one quote (shift_bp). Placebo = random path day, 40 draws, seed 372. Halves split on entry date 2023-01-01. Earnings dates: public.earnings_calendar. IV and spot: optlab.lseg_opt_daily.iv and lseg_research.daily_history. No download.

S109 trades 9,087 (reconciled, symmetric diff 0) · Jamie rule 420 · names 247 · 2020-12-30 → 2026-10-23 · option-only hold week-mean +40.1 bp/wk (S109 snapshot +42.6; book has grown) · median entry IV 0.55.

| exit | n (pre/post) | fired | unfilled | bp/wk | hold | diff | t | t pre | t post | worst 5% | hold 5% | tail | same-vol | verdict |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|
| roll_040 | 8878 (2240/6638) | 176 | 2260 | +45.7 | +46.2 | -0.5 | -1.1 | -0.7 | -0.9 | -117 | -112 | -0.04 | +46.3 | FAIL |
| roll_040 filled only | 176 (34/142) | 176 | 2260 | -8.6 | -5.1 | -3.6 | -0.2 | +0.8 | -0.8 | -190 | -271 | +0.30 | -13.3 | FAIL |
| roll_050 | 8878 (2240/6638) | 105 | 1451 | +47.2 | +47.1 | +0.1 | +0.5 | -0.7 | +0.7 | -117 | -111 | -0.05 | +47.6 | UNSUPPORTED |
| roll_050 filled only | 105 (21/84) | 105 | 1451 | -52.9 | -59.6 | +6.6 | +0.4 | — | +0.0 | -269 | -343 | +0.22 | -75.7 | UNSUPPORTED |
| close_d50 | 9087 (2315/6772) | 1572 | 0 | +34.9 | +46.4 | -11.5 | -3.8 | -1.9 | -3.3 | -119 | -117 | -0.02 | +39.2 | FAIL |
| close_iv30 | 8878 (2240/6638) | 3737 | 0 | +29.6 | +46.3 | -16.7 | -4.4 | -4.4 | -2.5 | -105 | -116 | +0.10 | +34.9 | FAIL |
| close_earn | 9087 (2315/6772) | 1701 | 0 | +38.3 | +46.4 | -8.2 | -1.9 | -2.5 | -0.9 | -96 | -117 | +0.18 | +49.8 | FAIL |

Jamie-rule subset (not the pass universe; S109 income ≥ 0.9%/wk, ≥ 10% OTM, ≥ 25% off high):

- roll_040: n 402 (118/284) fired 4 diff +1.1 t +1.0 / +0.9 tail +0.00 UNSUPPORTED
- roll_050: n 402 (118/284) fired 3 diff +1.2 t +1.0 / +1.0 tail +0.00 UNSUPPORTED
- close_d50: n 420 (128/292) fired 69 diff -14.0 t -1.7 / -0.4 tail +0.05 FAIL
- close_iv30: n 402 (118/284) fired 147 diff -48.5 t -3.7 / -2.0 tail +0.13 FAIL
- close_earn: n 420 (128/292) fired 162 diff -42.1 t -2.5 / -1.9 tail +0.27 FAIL

Leak and placebo (full S109 set):

- roll_040: shift_bp +0.2 (exit fill next quote) · entry_shift_diff -0.3 · placebo_p 0.00
- roll_050: shift_bp -0.2 (exit fill next quote) · entry_shift_diff -0.2 · placebo_p 0.00
- close_d50: shift_bp +6.4 (exit fill next quote) · entry_shift_diff +5.2 · placebo_p 0.00
- close_iv30: shift_bp +4.1 (exit fill next quote) · entry_shift_diff +1.5 · placebo_p 0.00
- close_earn: shift_bp -1.5 (exit fill next quote) · entry_shift_diff +1.1 · placebo_p 0.00

Primary universe is every S109 weekly put. Close rules are scored on the whole book (no trigger = same as hold). Roll verdicts use only the trades where a next-week lower strike was in cache; a half under 30 filled trades is UNSUPPORTED, not a t-stat. One roll, then hold. Daily quotes only. placebo_p is the share of random-day exits whose gap matched or beat the rule (0 = rule beat every shuffle) and is not the pass test.

