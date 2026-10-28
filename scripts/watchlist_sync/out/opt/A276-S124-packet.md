# A276 packet — S124 (A184 #2 intraday momentum)
- script: `analysis/s124_intraday_momentum.py` · window 2026-01-02→2026-10-16
- n=396 name-days · signed mean after 1bp cost +0.0029% · NW-t +0.32
- halves Jan–May -0.0137% / Jun–Oct +0.0201% · always-long last-30 -0.0063%
- SPY n=198 mean -0.0090% · QQQ n=198 mean +0.0148%
- bar: mean>1bp after cost, NW-t≥2, same-sign halves, beats always-long
- hand-check: SPY 2026-01-14 first30 -0.839% last30 +0.139% signed -0.139%
- surprises: QQQ rows=198; minute closes only (no h/l)
- out: `out/opt/S124.md`
- cursor_verdict_hint (Claude owns wording): FAIL
