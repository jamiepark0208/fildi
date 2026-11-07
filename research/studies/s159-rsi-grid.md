# S159 — RSI extreme grid (2003→ LSE panel)

**Panel:** `~/.fildi/cache/fast_screen_bars_2003.pkl` — LSE `export_stock_csv` 1d 2003-01-01→, split-adjusted (optlab.splits + LSEG overlap + jump detect); **674 survivors** (names with CSV today); VIX from `wrds_research.cboe_daily`. Fetch: `s159_lse_panel.py` · log `logs/s159-lse-2003.log`.

**Run:** `analysis/s159_rsi_grid.py --panel ~/.fildi/cache/fast_screen_bars_2003.pkl` → `out/s159_rsi_grid.csv`. Put legs: short 0.20/0.30Δ, 10 DTE, BS marks, **IV = prior-day RV20×1.2** (labelled). Eras 03-07 / 08-12 / 13-19 / 20-26 on day-clustered lift.

## Packet (2003→, Wilson ≥10 signal days)

1. **QQQ RSI14<25 → long QQQ, h5:** 14 days, win_lo **69 %**, lift +4.1 pp; eras 08-12 +3.9 %, 13-19 +4.5 %, 20-26 +6.0 % (03-07 thin/negative).
2. **QQQ RSI14<30 → QQQ, h2–3:** 40 days, win_lo **60–62 %**, lift +1.5–1.8 pp; all four eras positive (+0.5–3.5 %).
3. **QQQ RSI14<25 → all stocks, h5:** lift **negative** (−3.1 pp, win_lo 60 % but cross-section dilutes) — index-only edge, not basket.
4. **VIX>30 → all stocks long, h3–5:** 53 days, win_lo 54–56 %, lift ~0 (panic bid already in stocks).
5. **VIX>30 → short 0.20Δ put (RV20×1.2):** 53 days, win_lo **55–56 %**, lift +0.1–0.3 pp (marginal; era split mixed).
6. **SPY RSI14<25 → SPY h5 (2003→):** see CSV — Wilson lo band below QQQ depth (fewer events).
7. **Stock RSI14<5 cross (h3):** 10 days only, win_lo 60 %, lift tiny (+0.5 pp); **13-19 +7 %**, 20-26 **−4 %** → not robust.
8. **Neighbours:** QQQ RSI14<22.5/<27.5 hold 5 similar sign; SPY/QQQ put-on-stress cells q>0.05 — do not promote puts on RSI alone.
9. **Survivorship:** universe = today's `source_fundamentals` members only; delisted losers absent → stock-level rare-RSI lifts upward biased vs true 2003 cross-section.
10. **Self-test:** AAPL/NVDA/TSLA split-adj series: no −50 %+ gap days; SPY 2003 level plausible post-adjust.
