# TradingView indicators in Fildi — what exists, what's tested, where to use them
> Shared (all agents). Owner: Claude (A279 / A281). Jamie 10-26: "I use these indicators frequently … regime, confidence, when to
> enter or close, context, momentum, RSI, liquidity, S/R zones, volume". Read before adding any technical indicator or rule.

## Built (one home — do not re-implement)
`scripts/watchlist_sync/indicators.py` → nightly `watchlist_sync.indicators_daily` (daily.py stage "indicators", 268 names).
Daily bars, point-in-time (pivots counted from their confirm bar). `compute(d, h, l, c, v)` returns full series for charts/tests.
| Source guide | Fields | Notes |
|---|---|---|
| Luxy UT God Mode (UT Bot) | `ut_dir` `ut_bars` `ut_dist` (ATR) `ut_surv` (share of past same-side trends that ran longer) `ut_conf` (7-engine 0–100) | current guide default = Auto preset → daily Swing: sensitivity 2.0, ATR 14, filters off, Smart Chop (Kaufman ER) on; divergence RSI 14 / pivot 5. Page metadata still carries the July-16 v1 inputs (1.2 / ATR 7, swing + full-candle filters on) — superseded by the Jul-17/20 release notes. Chop widening formula approximated |
| SuperTrend Weighted by Divergence | `stdiv_dir` `div_against` `rsi_div` | author defaults (page metadata): ATR 10, base × 3, pivot 2, sensitivity 0.3, 200 bars; MPO4 (proprietary) → RSI(14) |
| SuperTrend Cluster (Zeiierman) | `stc_bull` (0–1 weighted agreement) `stc_regime` | author defaults: EMA3/ATR7/1.5/w1 · EMA5/10/2/1 · SMA8/14/2.5/1.2 · WMA13/21/3/1.4 · HMA21/34/4/1.6; consensus 0.6, base member 3 |
| Liquidity Hunter PRO (SMC) | `bos_dir` `sweep_age` `sweep_low` `mss_age` `fvg_dist` `ob_dist` (ATR) | author defaults: swing 5, max 10 bars after sweep, OB search 15, ATR 14; reversal body ≥ 0.15 ATR vs the open and order blocks on close < open (opens backfilled 10-26; missing open → close vs prior close) — guide suggests 1h, we run daily |
| Fear & Greed (BigBeluga) | `fear_greed` 0–100 | author defaults: RSI 14, SMA 50, volume flow 20, 70 / 30 (exact) |
Also: `sector_etfs.py` (49 sector/theme ETFs, `board`), market/sector/breadth state in `band_engine.py` (breadth = share of names with `ut_dir` > 0, from indicators_daily).
Surfaces today: put_recs payload `tech` → Rankings › Sell Puts badge (cluster %, tooltip); `put_manage.py` → `put_manage_daily`.

## Tested (sold puts) — read before proposing a rule
| Study | Role tested | Result |
|---|---|---|
| S102 | filter on 1-week puts held to expiry | 17/17 fail — wrong role (Jamie 10-26), kept for the record |
| S103 | entry timing × exits × re-sell, per-name lane; exits re-checked on real LSEG bid/ask | weekly take at ≥ 4× plan pace = only positive exit (+25 %, t ≈ 1) → `put_manage.py`; 50/65 % takes lose on real fills; 3-week early exits lose; **trend-flip stops lose (t −1.8…−3.7)** |
| S103b | which names to sell today (cross-section, same day) | no signal passes; SMC sweep-reclaim positive in every variant (t ≤ 1.5) → forward watch |
| S103 real | fear / bear-cluster names held to expiry | earn far more, but across weeks (market state, = band engine), not within a week |
| S105 (T3) | UT trail as a stop on held stock | FAIL: halves drawdown (−26 vs −38 %) but α vs hold −1.7 %/yr (t −0.9, β 0.48) — holding half the shares is cheaper |
| S107 | all factors at once (GBM) | indicators are the model's top-2 inputs (UT trail distance, Fear & Greed) yet add no pick return (M1−M0 −1.8 bp, t −0.3) |
| S108 (T1) | intraday order timing (15-min UT turn, 1-h sweep) | FAIL: random-time placebo = signal (+26.6 vs +26.6 bp) |
| S106 (T2) | covered-call timing (greed ≥ 70 / bearish divergence) | FAIL: per written call −15…−17 bp vs Monday −13 (2023→); only "wins" by writing fewer calls |
Standing rules from these: never close a sold put only because a trend indicator flipped; model marks overstate early buy-back value — judge exits on `optlab.lseg_opt_daily`; week-cluster comparisons so a market-state effect isn't read as name selection.

## Use-case map (Claude 10-26; A281 asks Muse / Cursor / Grok to add and challenge)
Status: **live** · **test** (needs a study with a pass bar) · **build** (display, no edge needed — Jamie uses them as context).
| # | Use | Indicators | Fildi surface | Status |
|---|---|---|---|---|
| 1 | Chart overlays (UT trail, cluster line + %, SMC FVG/OB/swept lows, BOS/MSS labels, divergence dots, F&G pane) | all | A93 TradingView-class chart | build |
| 2 | "Trend read" card: regime, confidence, trend age + survival, RSI, last liquidity event, nearest S/R, volume flow, one plain sentence | all | Breakdown › Technicals | build |
| 3 | Strike context on every pick: strike vs UT trail / swept low / nearest OB-FVG in ATR ("below last week's swept low") — words only | UT, SMC | Model List, Rankings, Structures | build (context only; S088: zone placement ≈ 0 once distance is in the model; a strike moves only if test T1 passes) |
| 4 | Engines-disagree line: "trend engines disagree; the book still follows put-edge" — never a skip | UT, cluster | Model List, Rankings | build (wording per Grok: disagreement failed as a filter, S102) |
| 5 | Regime board: cluster % + F&G per sector ETF; breadth = % of universe with UT up / cluster bull | cluster, F&G, UT | Macro / sector board | build |
| 6 | Breadth washout: ≤ 25 % of names in a UT Bot uptrend | UT (breadth) | reason-string label (`breadth_washout` flag in band_states) | **label + forward watch** — S104: +5.7 bp on the 9 test weeks it fires, t 0.8, tail worse → not a band state (Grok A281 ablation) |
| 7 | Intraday order timing: on a day the engine already chose, sell on the 1h SMC sweep-reclaim / 15-min UT turn → better premium | SMC, UT (intraday) | Live › Best strikes | test (Polygon 1-min backfill, ~2 y) |
| 8 | Tenor (narrowed, Grok): skip the 3-week put only in the first week after a UT down flip; grade breach | UT | put_recs | test (fail → drop tenor use) |
| 9 | Covered calls / call side: greed ≥ 70, bearish divergence, cluster topping → sell calls closer | F&G, div, cluster | call_recs (S101c) | **failed** S106 (T2) — no call timing rule |
| 10 | Directional entries (native use): UT flip + confidence + cluster agreement → long call / buy stock; UT trail as stop | UT, cluster | long options (A244), Model List Own | test |
| 11 | Wheel after assignment: keep the fixed hold (S088e); a UT flip line on the shares, stating that flip stops lost on puts | UT, F&G | Model List assigned shares | build (context) |
| 12 | Holdings risk: UT trail as trailing stop on long stock (drawdown vs return) | UT | Portfolio | **failed** S105 (T3) — display the trail as context only; a smaller position cuts risk cheaper |
| 13 | Per-name reliability: puts kept vs breached after each signal, past bars only, with n and both periods (never a stock-direction win rate) | all | tooltips | build |
| 14 | ~~Confidence as put-edge tie-break~~ | — | — | **killed** (Grok): no same-day signal (S103b), cluster already in the premium; ties break on the spread |
| 15 | Alerts: sold puts → pace take only (`put_manage.py`); sweeps / BOS / F&G extremes / UT flips as info on long shares + watchlist, never "close the put" | SMC, F&G, UT | Live alerts (A280) | build |
| 16 | Volume-flow spikes | F&G volume part | Live movers | test only if the residual after S094 flags + IV still pays |

## Next tests (Grok A281, pass bars pre-registered; one-day signal lag — signals publish after the close)
| id | Use | Test | Pass |
|---|---|---|---|
| T1 ✗ S108 | Intraday order timing (map 7) | same strike/expiry as the open sale; wait for a 15-min UT turn or a 1h low-sweep reclaim with the strike under that low; real quotes; T-bill if it never prints | more bp per collateral-day than selling at the open, breach no worse, same sign both halves, week-cluster t ≥ 2.5, shuffled-minute placebo ≈ 0 |
| T2 ✗ S106 | Covered-call timing on shares already held (map 9) | same Δ as Monday's call, written when F&G crosses 70 or a bearish divergence confirms | assignment-adjusted pnl beats holding the shares and the Monday write, both periods, t ≥ 2.5 (S088d: closer calls gave away the rally) |
| T3 ✗ S105 | UT trail on stock already held (map 12; native instrument for a ratchet) | trail vs hold vs a vol-scaled smaller position (S064), real fills | higher return per unit of risk than both, same sign both halves, t ≥ 2.5; long-call version only if 2023–26 survives flip dates shuffled within IV |

## Implementation gaps (Grok A281) — change answers if fixed
Daily series only: swings confirm 5 bars late (a fresh daily sweep is ~a week old) and SMC/UT are tuned for 1h/15m → intraday run needed for T1. "Weekly" engine = daily EMA 45/105, no real weekly bars. No stacked zones (FVG, order block, trail are separate distances) and no liquidity above highs (calls). Jamie runs author defaults (10-26) → settings now match the scripts' published inputs (pulled from page metadata 10-26); remaining gaps: timeframe (daily vs the guides' 1h/15m) and Luxy's adaptive chop formula.
