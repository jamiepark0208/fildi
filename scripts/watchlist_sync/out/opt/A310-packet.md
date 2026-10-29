# A310 packet — wheel baseline vs Fildi engine (2026-10-28)

Data: 272,798 S088 1-wk put candidates (111,181 fit ≤2022); one pick per name-week; P&L = real-fill hc (bp/collateral-wk).

(a) Alpaca score 0.05–0.30Δ: all +24.9 bp/wk · w5 -177 · breach 16.9% (n=64,636) · H1 +15.3/w5 -284 · H2 +32.7/w5 -101.
(b) Robinhood max yield Δ≤0.15: all +21.8 bp/wk · w5 -110 · breach 10.8% (n=60,362) · H1 +13.7/w5 -194 · H2 +28.3/w5 -62.
(c) Fildi band engine: all +28.7 bp/wk · w5 -47 · breach 7.6% (n=23,031) · H1 +27.7/w5 -81 · H2 +29.6/w5 -31.
(d) fixed 0.11Δ: all +22.3 bp/wk · w5 -105 · breach 10.6% (n=64,738) · H1 +14.3/w5 -179 · H2 +28.8/w5 -52.

Primary (2023→): (c)−(a) book bp -3.2 · week-cluster t -0.7 (H1 +12.4 · H2 -3.2).
Pass: holdout (c)≥(a) P&L with |t|≥2, or ~equal P&L with lower worst-5% week.
**Verdict: FAIL** — holdout engine +29.6 vs Alpaca +32.7 bp/wk; t=-0.7; w5 -31 vs -101.
Alpaca leads most in sharp_drop (-6 bp/trade); Fildi best in bear_grind (+7)
Refs: Robinhood +21.8 bp · fixed 0.11Δ +22.3 bp (same pool).
