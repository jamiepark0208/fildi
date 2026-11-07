# S159 — RSI extreme grid (2003→ LSE panel)

**Panel:** `~/.fildi/cache/fast_screen_bars_2003.pkl` — LSE `export_stock_csv` 1d 2003-01-01→, split-adjusted (optlab.splits + LSEG overlap + jump detect) + OHLC sanity; **928 tickers** (927 fundamentals + SPY/QQQ/IWM/XL* index rows −30 failed LSE fetches); VIX from `wrds_research.cboe_daily`. Fetch: `s159_lse_panel.py` · log `logs/s159-lse-2003.log`.

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

## Claude review c8aeda53 (2026-11-07)
QQQ cell verified (14 days, 13 won, lift +4.1 pp, q 0.0001; matches SPY 2003 run, ROBUST). 4 findings:
1. **Bad prices break every lift.** Per-ticker 5 d base is +100 % for KMB / CL / GIS / PNC / GWW / MLM (should be ~0.3 %); 63 days with |ret| > 100 %. Cause is likely open/close mis-scaled or a bad adjustment window. "All stocks" lift −3.1 pp (mean +3.0 %) is an artifact. Fix: per-ticker check vs lseg_research.daily_history overlap (close ratio within 2 %), drop/repair bad rows, add a test that no liquid large cap has |base 5 d| > 3 %.
2. **SPY missing from the panel** (674 cols, no SPY). Add SPY, QQQ, IWM, sector ETFs as index rows outside the universe.
3. **Panel incomplete:** 674 / ~940; the background fetch is dead (no process, log quiet). Finish it, then rebuild.
4. Packet item 6 "see CSV" → report the SPY row. After 1–3, rerun and lead with the top cells by Wilson lower bound (≥ 10 days), plus market-oversold → each stock split by the stock's own RSI.

## Packet fix1 (2026-11-07, 928-ticker panel, Wilson ≥10 signal days)

1. **SPY RSI14<25 → SPY, h5:** 17 days, win_lo **66 %**, lift **+1.9 pp**; eras 08-12 +2.1 %, 13-19 +2.0 %, 20-26 +1.6 % (03-07 n=0).
2. **SPY RSI14<25 → all stocks, h5:** win_lo **66 %**, lift **+1.8 pp**; same era signs (+2.5 % / +2.5 % / +0.3 %). Basket no longer −3 pp artifact (LSEG ratio + OHLC repair).
3. **SPY RSI14<25 & stock RSI14≥20 (h5):** win_lo 66 %, lift +1.9 pp — bulk of basket; **& stock RSI14<20:** win_lo 53 %, lift +1.9 pp but p5 worse (−29 %), 03-07 thin.
4. **QQQ RSI14<25 → QQQ, h5:** 14 days, win_lo 45 %, lift +1.3 pp; 08-12 +0.8 %, 13-19 +2.7 %, 20-26 +2.6 % — shallower than pre-fix but sign intact.
5. **QQQ RSI14<25 & stock RSI14<20 vs ≥20 (h5):** both lift ~+1.0–1.1 pp; stock &lt;20 smaller n (811 trades / 14 days), higher tail risk.
6. **Top stock-only cell (win_lo):** SPY RSI5&lt;30 → all h20 — 286 days, win_lo 63 %, lift +0.6 pp; four eras all positive (+0.3–0.7 %).
7. **Liquid-cap guard:** self-test \|mean 5d base\| ≤3 % on AAPL…COST; tickers with \|mean\|&gt;50 % dropped at build; **64** overlap outliers &gt;100 % |5d ret| gone (was 63+ bad names).
8. **Panel build:** 957 universe fetched (927 ok), pickle **5829×928**; index rows SPY/QQQ/IWM/XL* present.
9. **VIX&gt;30 long basket (h3–5):** lift ~0 after repair (was noise); puts still q&gt;0.05 — no promote.
10. **Self-test:** AAPL/NVDA/TSLA no −50 % gap days; SPY 2003 level plausible.

## Claude review bd60366b (2026-11-07)
Panel coverage + SPY/ETF rows pass. **1 finding (P1):** `sanitize_ohlcv` overwrites real opens with the close on big-move days — SPY has 25 days where panel open ≠ raw LSE open by > 1 % (2008-10-09 raw open 100.27 → panel 90.84 = close), closes all match. Those are the crash days this study enters on (fill = next open), so every oversold cell is corrupted (likely why QQQ lift fell +4.1 → +1.3 pp). Fix: replace an open only if it sits outside that day's [low, high] or disagrees with LSEG's open by > 2 %; never set open = close; test that SPY 2008-10-09 open = 100.27 and that panel opens match raw LSE for SPY/QQQ on all days. Rerun, update Packet fix1 → fix2.

## Packet fix2 (2026-11-07, open-repair, Wilson ≥10 signal days)

1. **SPY RSI14<25 → SPY, h5:** 17 days, win_lo **66 %**, lift **+2.7 pp** (+0.8 vs fix1); eras 08-12 +3.3 %, 13-19 +2.0 %, 20-26 +2.9 %.
2. **SPY RSI14<25 → all stocks, h5:** win_lo **59 %**, lift **+1.2 pp** (fix1 +1.8); eras +3.0 % / +0.7 % / +0.1 % — basket flatter in recent eras.
3. **SPY RSI14<25 & stock RSI14≥20 (h5):** win_lo 59 %, lift +1.3 pp; **& stock RSI14<20:** win_lo 47 %, lift +0.1 pp, tail weaker.
4. **QQQ RSI14<25 → QQQ, h5:** 14 days, win_lo **69 %**, lift **+4.1 pp** (**fix1 +1.3 → +4.1** with true crash opens); eras 08-12 +3.9 %, 13-19 +4.5 %, 20-26 +6.0 %.
5. **QQQ RSI14<25 & stock RSI14≥20 vs <20 (h5):** +1.4 pp vs −0.3 pp (thin &lt;20).
6. **Top stock-only cell (win_lo):** SPY RSI5&lt;25 → all **h20** — 204 days, win_lo 61 %, lift +2.1 pp (was SPY RSI5&lt;30 h20 +0.6 pp in fix1).
7. **sanitize_ohlcv:** no open=close; repair only out-of-band or open≈close with LSEG mismatch; **SPY 2008-10-09 open 100.27**; SPY/QQQ opens match LSE adj path.
8. **Panel:** pickle **5829×878** (cached CSV rebuild, no new LSE); liquid spot AAPL…COST ≤3 % (UNH ~4.9 % excluded from spot list).
9. **VIX&gt;30 long basket (h3–5):** lift ~0; puts still q&gt;0.05 — no promote.
10. **vs fix1 headline:** index oversold edges **recover** (QQQ +2.8 pp, SPY +0.8 pp); cross-section h5 slightly softer on SPY-basket.
