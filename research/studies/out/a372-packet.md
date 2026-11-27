# A372 review packet (detail §1–3 quant)

CONTRACT 1-7: ok (item 3 priced_by=model; items 5–7 N/A for advisory architecture).
SHA: `794462f5` + this commit · smoke: all three `a372_*.py --smoke` SANITY pass · full re-run 2026-11-26.

**Item 1 — put exits vs hold (S109, LSEG daily, n=9,087):** hold +40.1 bp/wk. Roll |Δ|≥0.40 filled **FAIL** (−8.6 vs −5.1). Roll |Δ|≥0.50 **UNSUPPORTED** (pre n=19). Close |Δ|≥0.50 / IV+30% / pre-earn all **FAIL** (mean −8…−17 bp/wk vs hold, tails worse). → keep hold-to-expiry for the graded put lane; daily rolls need more next-week chain cache.

**Item 2 — book layer (S047 IRA 396 trades):** vol_scaled **NO-LIFT** (+55.6 vs +62.4 bp/wk, max DD −3.2% vs −2.2%); corr_cap noop. Stress 2020-03 modelled: vol_scaled −34 vs −43 bp/trade.

**Item 3 — covered-call ATD exits (S046, model BS):** single flags **FAIL**; `any_atd` **WORKS** on model only (+31.7 bp/wk, t 36) — not shippable without real call quotes + contract 13 entry minute.

**In Fildi:** no score/Model List change. **For your trades:** early take/roll/Δ/IV/earn exits do not beat holding puts on this evidence; vol-based sizing did not improve the 2026 IRA book. **Open (same row):** §6 regime eval, chart, fold `portfolio.py:manage` into `put_manage`.

Refs: A372 · reports `a372-exits.md`, `a372-book.md`, `a372-call-exits.md`