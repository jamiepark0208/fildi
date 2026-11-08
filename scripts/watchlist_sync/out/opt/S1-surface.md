# A192 Part S1 — per-stock vol surface

Runtime 179.0s · fitted slices 63,542 · CM rows 19,057

| source | ticker-days fitted |
|---|---:|
| option_chain_history | 3,676 |
| skew_survey | 2,158 |
| lseg_opt_daily | 37,971 |

Share ≥5 quotes: 20.4%
RMSE p50: 0.229 vol pt
b<0 share: 86.3%
Median |fit−quote| IV: 0.328 vol pt

```
SANITY rows=170 tickers=5 med_abs_iv_err=0.54volpt b_neg=96%
SANITY hand F AAPL 2026-10-11 F=336.75 spot via parity n=9
SANITY 30d AAPL 2026-10-11 atm_iv=28.04% b=-0.0396281051530892
SANITY gate=PASS (med≤1.0volpt b_neg≥80%)
```

## Latest 30d skew slope (b) percentiles

Bottom 10:
- SPY: b=-0.0441 pct=1.00 (sector:UNK)
- ATI: b=0.0413 pct=1.00 (sector:Industrials)
- FN: b=0.0667 pct=1.00 (sector:Information Technology)
- APP: b=-0.0218 pct=1.00 (sector:Telecommunication Services)
- COIN: b=-0.0510 pct=1.00 (sector:Financials)
- TLN: b=-0.0970 pct=1.00 (sector:Utilities)
- DKS: b=0.0557 pct=1.00 (sector:Consumer Discretionary)
- HIMS: b=0.0245 pct=1.00 (sector:Health Care)
- HPE: b=0.0340 pct=0.98 (sector:Information Technology)
- QCOM: b=0.0223 pct=0.95 (own)

Top 10:
- MPWR: b=-1.0124 pct=0.02 (sector:Information Technology)
- ONTO: b=-0.1859 pct=0.05 (sector:Information Technology)
- MU: b=-0.1521 pct=0.06 (own)
- SHOP: b=-0.1354 pct=0.08 (own)
- STRL: b=-0.3647 pct=0.08 (sector:Industrials)
- NTAP: b=-0.1508 pct=0.10 (sector:Information Technology)
- KEYS: b=-0.1420 pct=0.12 (sector:Information Technology)
- ADI: b=-0.1223 pct=0.17 (sector:Information Technology)
- GNRC: b=-0.1505 pct=0.17 (sector:Industrials)
- TSLA: b=-0.1026 pct=0.17 (sector:Consumer Discretionary)