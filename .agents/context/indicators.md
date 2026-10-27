# TradingView indicators in Fildi — what exists, what's tested, where to use them
> Shared (all agents). Owner: Claude (A279 / A281). Jamie 10-26: "I use these indicators frequently … regime, confidence, when to
> enter or close, context, momentum, RSI, liquidity, S/R zones, volume". Read before adding any technical indicator or rule.

## Built (one home — do not re-implement)
`scripts/watchlist_sync/indicators.py` → nightly `watchlist_sync.indicators_daily` (daily.py stage "indicators", 268 names).
Daily bars, point-in-time (pivots counted from their confirm bar). `compute(d, h, l, c, v)` returns full series for charts/tests.
| Source guide | Fields | Notes |
|---|---|---|
| Luxy UT God Mode (UT Bot) | `ut_dir` `ut_bars` `ut_dist` (ATR) `ut_surv` (share of past same-side trends that ran longer) `ut_conf` (7-engine 0–100) | ATR(14)×2 ratchet + Kaufman ER chop; Luxy's adaptive layer approximated |
| SuperTrend Weighted by Divergence | `stdiv_dir` `div_against` `rsi_div` | ST(10,3), multiplier −30 % ≤ 200 bars after an against-trend divergence; MPO4 (proprietary) → RSI(14) |
| SuperTrend Cluster (Zeiierman) | `stc_bull` (0–1 weighted agreement) `stc_regime` | 5 members, weights/lengths ours (author's not published) |
| Liquidity Hunter PRO (SMC) | `bos_dir` `sweep_age` `sweep_low` `mss_age` `fvg_dist` `ob_dist` (ATR) | 5/5 pivots on daily (author tunes for 1h → MSS rare) |
| Fear & Greed (BigBeluga) | `fear_greed` 0–100 | RSI + close/SMA50 percentile + 20-day up-volume share |
Also: `sector_etfs.py` (49 sector/theme ETFs, `board`), market/sector/breadth state in `band_engine.py` (breadth = share of names with `ut_dir` > 0, from indicators_daily).
Surfaces today: put_recs payload `tech` → Rankings › Sell Puts badge (cluster %, tooltip); `put_manage.py` → `put_manage_daily`.

## Tested (sold puts) — read before proposing a rule
| Study | Role tested | Result |
|---|---|---|
| S102 | filter on 1-week puts held to expiry | 17/17 fail — wrong role (Jamie 10-26), kept for the record |
| S103 | entry timing × exits × re-sell, per-name lane; exits re-checked on real LSEG bid/ask | weekly take at ≥ 4× plan pace = only positive exit (+25 %, t ≈ 1) → `put_manage.py`; 50/65 % takes lose on real fills; 3-week early exits lose; **trend-flip stops lose (t −1.8…−3.7)** |
| S103b | which names to sell today (cross-section, same day) | no signal passes; SMC sweep-reclaim positive in every variant (t ≤ 1.5) → forward watch |
| S103 real | fear / bear-cluster names held to expiry | earn far more, but across weeks (market state, = band engine), not within a week |
Standing rules from these: never close a sold put only because a trend indicator flipped; model marks overstate early buy-back value — judge exits on `optlab.lseg_opt_daily`; week-cluster comparisons so a market-state effect isn't read as name selection.

## Use-case map (Claude 10-26; A281 asks Muse / Cursor / Grok to add and challenge)
Status: **live** · **test** (needs a study with a pass bar) · **build** (display, no edge needed — Jamie uses them as context).
| # | Use | Indicators | Fildi surface | Status |
|---|---|---|---|---|
| 1 | Chart overlays (UT trail, cluster line + %, SMC FVG/OB/swept lows, BOS/MSS labels, divergence dots, F&G pane) | all | A93 TradingView-class chart | build |
| 2 | "Trend read" card: regime, confidence, trend age + survival, RSI, last liquidity event, nearest S/R, volume flow, one plain sentence | all | Breakdown › Technicals | build |
| 3 | Strike context on every pick: strike vs UT trail / swept low / nearest OB-FVG in ATR ("below last week's swept low") | UT, SMC | Model List, Rankings, Structures | build (S088: placement adds no return → context, not a rule) |
| 4 | Against-the-trend chip: Fildi rec vs trend engines disagree | UT, cluster | Model List, Rankings | build |
| 5 | Regime board: cluster % + F&G per sector ETF; breadth = % of universe with UT up / cluster bull | cluster, F&G, UT | Macro / sector board | build |
| 6 | Breadth washout as a market state: ≤ 25 % of names in a UT Bot uptrend while SPY calm → sell closer (0.12–0.20Δ) | UT (breadth) | band_engine `breadth_washout` | **live** 10-26: OOS +30.1 vs +29.6 bp/wk, Sharpe 5.31 vs 4.84, max DD −4.5 vs −5.0 %; cells +72/−17 (crashed 0.12–0.15) · +47/−77 (normal 0.20) |
| 7 | Intraday order timing: on a day the engine already chose, sell on the 1h SMC sweep-reclaim / 15-min UT turn → better premium | SMC, UT (intraday) | Live › Best strikes | test (Polygon 1-min backfill, ~2 y) |
| 8 | Tenor by trend-duration forecast (long expected downtrend left → shorter put) | UT survival | put_recs | test |
| 9 | Covered calls / call side: greed ≥ 70, bearish divergence, cluster topping → sell calls closer | F&G, div, cluster | call_recs (S101c) | test |
| 10 | Directional entries (native use): UT flip + confidence + cluster agreement → long call / buy stock; UT trail as stop | UT, cluster | long options (A244), Model List Own | test |
| 11 | Wheel after assignment: hold shares while UT up, sell calls on flip or greed | UT, F&G | Model List assigned shares | test |
| 12 | Holdings risk: UT trail as trailing stop on long stock (drawdown vs return) | UT | Portfolio | test |
| 13 | Per-name signal reliability (Luxy-style win-rate table, honest, from Fildi's own history) | all | tooltips | build |
| 14 | Setup-agreement score as tie-break inside equal put-edge | UT conf, cluster | put_recs rank | test |
| 15 | Alerts on holdings/watchlist: sweep + reclaim, BOS through support, F&G extreme, UT flip (with the tested stance) | SMC, F&G, UT | Live alerts (A280) | build |
| 16 | Volume flow spikes as unusual activity | F&G volume part | Live movers | test (overlaps S094) |
