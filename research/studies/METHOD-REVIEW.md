# Fildi — how we find and backtest trade ideas (for outside review)
> 2026-11-07 · Claude. Written for an external reviewer (TradingView Copilot) to find where the method is weak. Verdict board: `BOARD.md` · rules: `METHODS.md` · how-to: `PLAYBOOK.md`.

## 1. What to review
Please look for:
- Entry or exit conditions a discretionary or systematic trader would use that we never test.
- Indicators judged on the wrong job (direction instead of trend filter, timing, regime, volatility).
- Validation mistakes: look-ahead, overfitting, wrong comparator, too few independent events, cost/fill assumptions too kind or too harsh.
- Timeframe mismatches between signal, bars and holding period.
- Strategy families we have not tried.

For each finding: the claim, why it matters, a concrete test we could run.

## 2. The trader and the trades
Main income = selling **weekly cash-secured puts** on US stocks. A "good idea" raises net put P&L per $ of collateral, or cuts the left tail at the same return.
- Core: weekly short puts, ~0.08–0.20 delta, held to expiry; covered calls after assignment (wheel).
- Side: long calls (momentum + rising analyst revisions); occasional SPY/QQQ trades.
- Universe ~940 US names; watchlist ~58; the Model List picks weekly put candidates.
- Broker Robinhood (fill ≈ bid + 23 % of spread); live quotes Schwab.
- Scoreboard: IRA put book +24.2 % vs SPY +12.2 % over 35 weeks, max drawdown −2.2 % (396 trades).
- Every study is graded on the decision it feeds (names, strike, size, avoid list), not on stock direction alone.

## 3. Data
| Need | Source | History | Limits / caveats |
|---|---|---|---|
| Daily OHLCV + ATM IV30/60/90 | LSEG (`lseg_research.daily_history`) | 2016→, ~273 names | split-adjusted to today's shares |
| Daily OHLCV long panel | LSE "London Strategic Edge" API | 2003→, 885 names | split-adjusted; survivors only |
| 1-minute bars | LSE API (resampled to 2/5/15m/1h) | 2003→ | 12.5M rows/day quota → ~35 names/day backfill; 21 names cached now |
| Option bid/ask/IV incl. expired | LSEG option prices | 2020-12→ | 1 request per contract-day; cached |
| Option trades + greeks | LSE OPRA | 2025-10→ | short history |
| Option chain snapshots | our own `option_chain_history` | 2026-10-06→ | accruing daily |
| Earnings dates + reactions | LSEG events / earnings_moves | 2016→ | true report dates, not fiscal period ends |
| Analyst data (StarMine, IBES revisions) | LSEG, WRDS | 2019→ / 2020→ | research only (license) |
| IV rank / liquidity | tastytrade | 2026-10-24→ | no vendor history |
| Outside option backtests | tastytrade backtester | 2013→, 147 symbols | spec-based |
| Macro / rates | FRED | decades | free |
| Live quotes/chains | Schwab | today | never used for backtests |

## 4. Engines and study flow
1. **Board check** — `BOARD.md` / `INDEX.md`: already tested?
2. **Fast screen** (`analysis/fast_screen.py`, daily bars, 68 cells ≈ 11 s + 1,030 use-case variants ≈ 28 s). Comparator = same-day peers in the same 20-day-vol decile (leave-one-out); t, deflated Sharpe, probability of backtest overfitting on monthly excess; placebo must give 0 survivors in ≥ 19/20 runs.
3. **Full study** only for what the screen flags or what needs minute bars / real option prices:
   - **Conditional engine (A359)**: 1m bars resampled to 1m/2m/5m/15m/1h/1d; signal on one timeframe, filter on a higher one (e.g. 5m signal + 1h RSI > 40, or price above 15m/1h EMA20); entries only when the condition fires; exits below; per-ticker spreads, scored at mid and at the cross.
   - **Option replay**: real LSEG option quotes where available; otherwise Black-Scholes at ATM IV × 0.85 (no skew).
   - **Own-trade replay**: Jamie's 396+ real puts on real option closes.
4. **Review**: second agent reviews the code diff (look-ahead, units, eval vs acceptance) before the verdict.
5. **Record**: INDEX row, BOARD line, per-stock stock notes; adopted rules go live as a shadow lane first, promoted after ≥ 8 expiries / ≥ 100 trades.

## 5. Validation rules
- Pre-registered question, target, pass bar and stop rule before the run.
- Walk-forward / held-out era (e.g. train ≤ 2018, test 2019→; or halves split at the median date); must hold in both halves.
- Comparator = same ticker, same strike distance on random days, or same-day vol-matched peers — never zero.
- Clustering by (ticker, week) for CIs; Holm or FDR across the family; |t| ≥ 3 for a new score input.
- Puts graded on premium kept / breach / P&L per collateral, never raw stock return; IV held fixed for option factors.
- Effective N (overlapping events de-duplicated, one per name per 10 days); N_eff ≥ 100 for a cell.
- Per-stock thresholds: global vs empirical-Bayes-shrunk per-stock cutoff, walk-forward (S160: per-stock lost).
- Leak checks: shift the signal one bar, shuffled-signal placebo (being built into every screen, A369).
- Cost-aware staging: gross, net-at-mid, net-at-cross side by side; an idea that loses to cost is re-screened at a cheaper structure (longer hold, daily bars, put-timing or sizing filter) before it is called dead.

## 6. Entry conditions tested
| Family | Conditions |
|---|---|
| Put selection | IV ÷ realised vol (main edge), IV rank, model P(kept) ≥ 90 %, delta 0.08–0.20, ≥ 10 % OTM, premium ≥ 0.9 %/wk, stock ≥ 25 % off high, earnings inside expiry, credit quality, StarMine alpha, trend vs 200-day |
| Put timing | panic drop + IV30 > 48.7; SPY 3-month ≤ −8 % with VIX ÷ VIX3M < 1; high-volume up day; SPY RSI14 bottom quintile; weekday / FOMC / CPI / opex weeks |
| Oversold / mean reversion | RSI 2/3/5/7/14 at thresholds 2…35 (1m → daily); ≥ 2σ 5-day drops; down-streaks; gap vs grind drops; SPY/QQQ RSI14 < 25 |
| Momentum / fundamentals | 60-day return + analyst revisions; forward EPS growth; DCF value gap; sector-relative laggards |
| Intraday indicators | UT Bot, SuperTrend flips, MSO CHoCH, VWAP, squeeze, chandelier, breadth divergence; multi-TF agreement filters |
| Macro / regime | credit spread width, NFCI, yield curve, SPY < 200-day, high IV regime, weak breadth |
| Structures | CSP vs put spreads, strangles, straddles, jade lizard, long calls, debit verticals |

## 7. Exit / close rules tested
- **Hold to expiry** (default for puts; won every comparison so far).
- Profit take 50 % / 65 % / 75 % of max (lose on real quotes unless freed cash is re-sold at once).
- Weekly pace ≥ 4–5× take + re-sell (only positive early exit, ~+0.02 % of strike/trade).
- Stop at 2× premium, close-if-ITM (both lose: −$13.7k on Jamie's book).
- Stock/intraday exits: take-profit 50 % of target, time stop 30 min / 5 days, RSI back above 50, hold overnight, exit at close.
- Not yet tested well: rolling (down/out), trailing stops on long calls, delta-based or IV-based exits, exit on earnings date.

## 8. Costs and fills
- Robinhood fill = bid + ~23 % of the spread (measured on Jamie's fills; range 10–36 %).
- Model option prices = BS at IV × 0.85; real LSEG fills ran 0.83–1.08× of the model.
- Stock/intraday: per-ticker measured spread; scored at mid and at the full cross.
- Idle collateral earns T-bill (FRED DTB3) in comparisons.
- No commissions on options at Robinhood; no slippage beyond the spread model; no borrow costs.

## 9. Results so far
**Works (out of sample):** Model List puts top-10/wk at P(kept) ≥ 90 % +77 bp/wk vs +35 plain 1σ · rich-put lane +101 bp/wk vs +34 (t 5.7) · panic puts kept +4.05 % vs +0.26 % · sharp-drop regime → higher delta pays · calls on revisions + 60d return +69.6 % vs +43.1 % · calls on low volume + not stretched +42.9 bp/wk · SPY/QQQ RSI14 < 25 → up 5 days later ≥ 66/69 % (Wilson lower bound, 17/14 events since 2003) · watchlist RSI14 < 25 → +2.0 pp / 5 d vs own avg (242 events) · wide credit spreads warn of S&P drops.
**Dead:** every intraday indicator signal (stock and options) after spread; short-term RSI dips 1m–1h; overnight carry after cost; spreads/strangles vs CSP; stops and profit takes; calendar/Fed weeks; streaks; post-earnings drift; bounce-after-drop; per-stock RSI cutoffs; sector-specific fundamental weights; recession model.

## 10. Known weaknesses (self-assessed)
1. **Indicator studies all failed** — likely because we tested indicators as stand-alone entries on direction, not in their trader role (trend filter, regime, exit, volatility). Confluence tested only lightly.
2. **Survivorship**: panels are today's survivors (bias ≈ 0 at ≥ $3/$300M, larger in small caps).
3. **Option history is thin**: real quotes 2020-12→, our chain snapshots only since 2026-10; much of the put work uses modelled prices without skew (skew fit failed: 2.69 vs 2 vol-point target).
4. **Few independent events** for rare signals (S159: 14–17 events in 23 years) and few market regimes (2020, 2022, 2025).
5. **Minute data coverage**: 21 names cached; quota limits breadth.
6. **Exit research is narrow**: no rolling, no IV/delta exits, no trailing stops for calls.
7. **Speed**: minute-engine grid 36 min for 21 names (target < 5); reruns from look-ahead/pricing bugs (3 this week).
8. **No position sizing / portfolio model** beyond per-trade rules; sector caps untested (A352).
9. **Short side unused**: no short-stock or put-buying hedges tested properly; call-selling only hinted.
10. **Earnings plays** (IV crush, earnings-crossing calls) only partly tested.

## 11. Questions for the reviewer
1. Which TradingView indicators work best as **filters for when to sell puts** (not as entries)?
2. What exit or management rules (rolling, delta/IV triggers) do systematic put sellers use that we should test?
3. Is a 14-event signal (S159) tradable, and how would you size it?
4. Are our cost assumptions (bid + 23 % spread) realistic for weekly options on mid-cap names?
5. Which strategy families should we test next given the data in § 3?
6. Any validation step in § 5 that is missing or overkill?
