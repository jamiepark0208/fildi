# A371 packet

CONTRACT 1-7: ok · 8: mixed real+s076 · 13: daily entries · 17: quantcore via s076/s109 · 18: LSEG daily+opt cache · 19: no new masks · 20: S010 haircut on synth legs, CRSP delist names

1 Survivorship: +75.5→+74.6 bp/wk (t +3.2→+3.2), +1 names / 6 synth puts, quote cov 13%, priced_by {'s076_model': 6} → S109 stays **Works**
2 S088 real replay (top-10/wk h=1, holdout): model +109.8 vs real +133.2 bp/wk (ratio 1.21, cov 3%); halves real H1 +82.6 (t +2.0); H2 +161.9 (t +8.5) — PASS
3 Regime S109: both SPY halves +; middle VIX weak — see a371-audit.md table
4 One standard: N_eff<100 → BOARD ## Low N_eff (S159,S172,S173); parser+S159 chip
5 Pass/fail task5: survivorship-adjusted S109 t=+3.2 bp=+74.6 → Works

## Dead spot-check (A371 add, sample)

- S020 framing? — spread $ P&L vs CSP margin/Risk; per-$BP not checked → re-test
- S026 framing? — CPI week approximated → re-test exact BLS dates
- S017/S103 costs — take rules fail on real quotes; verdict stands
- S193 power — survivorship; verdict stands pending CRSP history
