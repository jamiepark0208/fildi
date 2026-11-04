# A276 packet — S125 (A188 #1 Muravyev overnight)
- script: `analysis/s125_option_overnight.py --backfill 0`
- n_pairs=1821 stock-days=987 names=34
- seller overnight +3.686% · intraday +3.457% · diff +0.230% · cluster-t +0.16
- 2024 diff +3.326% (t +0.19) · 2025→ +0.211% (t +0.15)
- zero-vol dropped: 0.0% of 30,007 · bid+23% haircut N/A on daily bars
- bar: overnight−intraday>0, cluster-t≥2, same sign 2024 and 2025→
- hand-check: LRCX 2026-06-24 on +26.940% in -20.054% diff +46.994%
- out: `out/opt/S125.md`
- cursor_verdict_hint (Claude owns wording): FAIL
