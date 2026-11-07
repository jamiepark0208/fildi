# How we find and backtest trade ideas — please find our weak spots
Full version: METHOD-REVIEW.md. For each finding give: claim, why it matters, a test we could run.

## Trader
Sells weekly cash-secured puts (0.08–0.20 delta, held to expiry), wheels into covered calls; some long calls and SPY/QQQ trades. Robinhood fills ≈ bid + 23 % of spread. Live record: +24.2 % vs SPY +12.2 %, max DD −2.2 %, 396 trades / 35 weeks. Ideas are graded on put P&L per $ collateral and tail risk, not stock direction.

## Data
- Daily OHLCV: 2003→ (885 names, split-adjusted, survivors only); daily ATM IV 2016→ (~273 names).
- 1-minute bars 2003→, resampled to 2m/5m/15m/1h; quota limits us to ~35 names/day (21 cached).
- Option quotes incl. expired 2020-12→; option trades/greeks 2025-10→; own chain snapshots 2026-10→.
- Earnings dates, analyst revisions/StarMine 2019→, FRED macro, tastytrade IV rank (new).

## Process
1. Check the verdict board (already tested?).
2. Fast screen on daily bars (~40 s): comparator = same-day peers in the same volatility decile; deflated Sharpe, overfitting probability, shuffled placebo.
3. Full study only when needed: minute-bar engine (signal on one timeframe, filter on a higher one, per-ticker spread at mid and cross), real-quote option replay, or replay of the trader's own puts.
4. Second agent reviews the code for look-ahead/units before a verdict.
5. Winners go live as a shadow lane; promoted after ≥ 8 expiries / ≥ 100 trades.

## Validation rules
Pre-registered pass bar; train/test split by era (e.g. ≤ 2018 / 2019→) and must hold in both halves; ticker-week clustered CIs; Holm/FDR across tests; one event per name per 10 days; ≥ 100 effective events; puts graded on premium kept, not raw return; per-stock thresholds only if they beat a global one out of sample (they didn't for RSI); leak test (signal shifted one bar + shuffle); costs shown gross / mid / cross, and a cost-losing idea is re-tested in a cheaper form before it's called dead.

## Entry conditions tested
- Put selection: IV ÷ realised vol (main edge), IV rank, model P(kept), delta, % OTM, weekly premium %, distance off high, earnings in window, credit quality, trend vs 200-day.
- Put timing: panic drop + high IV, SPY 3-month drop with inverted VIX curve, SPY RSI low, calendar/Fed weeks.
- Mean reversion: RSI 2–14 at thresholds 2–35 on 1m→daily, 2σ drops, streaks, gaps.
- Momentum/fundamentals: 60-day return + analyst revisions, EPS growth, DCF gap.
- Intraday indicators: UT Bot, SuperTrend, MSO CHoCH, VWAP, squeeze, chandelier, breadth divergence, multi-timeframe agreement.
- Regime: credit spreads, NFCI, yield curve, SPY vs 200-day, breadth.
- Structures: CSP vs put spreads, strangles, straddles, jade lizard, debit verticals, long calls.

## Exits tested
Hold to expiry (wins so far); 50/65/75 % profit takes (lose on real quotes); weekly pace ≥ 4–5× take + re-sell (small positive); 2× stop and close-if-ITM (lose); intraday: take-profit, time stops, RSI > 50, overnight hold, exit at close. Untested: rolling, delta/IV-triggered exits, trailing stops on calls, exit before earnings.

## Results
Works (out of sample):
- Top-10 model puts with P(kept) ≥ 90 %: +77 bp/wk vs +35 plain 1σ puts.
- Rich puts (≥ 0.9 %/wk, ≥ 10 % OTM, ≥ 25 % off high): +101 bp/wk vs +34, t 5.7.
- Panic drop + IV30 > 48.7: puts kept +4.05 % vs +0.26 %.
- Sharp market drop + inverted VIX curve: higher-delta puts pay more.
- Calls on rising revisions + strong 60-day return: +69.6 % vs +43.1 %.
- SPY/QQQ RSI14 < 25: up 5 days later ≥ 66–69 % (only 14–17 events since 2003).
- Watchlist RSI14 < 25: +2.0 pp over 5 days vs own average (242 events).
- Wide credit spreads warn of S&P drops (25 % vs 13 % base).

Dead: all intraday indicator entries after spread; short-term RSI dips (1m–1h); overnight carry; spreads/strangles vs CSP; stops and profit takes; calendar weeks; streaks; post-earnings drift; per-stock RSI cutoffs.

## Weaknesses we already see
1. Indicators tested as stand-alone entries, not as filters for put timing, regime or exits.
2. Thin option history; much put work uses model prices without skew.
3. Rare signals have few events; few market regimes (2020, 2022, 2025).
4. Exit research narrow (no rolling, no IV/delta exits).
5. No portfolio sizing or sector caps tested.
6. Survivorship bias in small caps; minute data only 21 names.
7. Short side, hedges, and earnings IV-crush plays barely tested.

## Questions
1. Which TradingView indicators work best as filters for when to sell puts?
2. What exit/management rules do systematic put sellers use that we should test?
3. Is a 14-event signal tradable, and how would you size it?
4. Is bid + 23 % of spread realistic for weekly options on mid caps?
5. Which strategy families should we test next with this data?
6. Which validation step is missing or overkill?
