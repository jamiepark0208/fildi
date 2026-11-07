# Trade Decision Protocol v3 (Fildi)
> Source: Jamie 11-06, TradingView Remix AI "Trade Decision Protocol v2", reviewed and improved by Claude on S158 (RSI-extreme long screen). Applies to "backtest this", "is there an edge", "trade plan", "should I enter". Every agent. Engine: `scripts/watchlist_sync/analysis/conditional_engine.py` / `fast_screen.py` (A359).

## Known deficiencies (add new ones here before answering)
- D-1 Look-ahead: check fill bar, IV/fundamental timestamps (A6). Same-day EOD values used intraday = look-ahead (caught in A359 db04638d).
- D-2 Multiple testing: we have DSR / PBO / FDR in fast_screen. Use them; the A7 neighbourhood check is the minimum, not the test.
- D-3 Options: no Pine proxy. Price with the chain at entry (option_chain_history, LSE OPRA marks 10/2025 →); else BS on **prior-day** IV with an IV path, and say which. Friction = per-ticker spread at that moneyness/DTE, two fills (mid + ¼ spread, full cross).
- D-4 Expectancy has no CI → report a bootstrap CI over **signal days**, not trades.
- D-5 Correlation → 1 in crashes: clustered hits (same day / same sector) count once (N_eff = distinct signal days or sector-days).
- D-6 Slippage on illiquid names: per-ticker spreads, not a flat bp (A359 9bb441f3 priced every trade as illiquid).
- D-7 Regime shift: always split pre-2022 / 2022 / post-2022 and SPY above/below SMA200. A result that lives in one era is not an edge.
- D-8 Catalysts: split earnings-window hits from the rest (RSI extremes often = earnings gaps).
- **D-9 Survivorship (added by Claude):** our bar universe = tickers alive today. Dip-buying tests are biased **up** (the crashes that delisted are missing). Say so on every long-the-dip verdict; size the bias when a delisted set exists.
- **D-10 Wrong comparator (added):** buy-and-hold / every-day base on the whole universe flatters signals that select high-vol names. Comparator = same ticker's every-day return over the same hold (lift), plus a vol-decile-matched random entry.

## Module A — verification gate (before any edge claim)
- A1 Engine alive: 1-trade sanity run, trades > 0.
- A2 Window: dates, bars, tickers; must span ≥ 2 regimes (incl. 2022).
- A3 Condition fires: report min indicator value and ticker-days past the threshold. Zero or near-zero hits = DATA finding, not "no edge".
- A4 Falsifiable: hits n, **N_eff (distinct signal days)**, win, mean, median, PF, avg win, avg loss, p5 tail, max DD, lift vs same-ticker base, executed rules. N_eff < 30 → INSUFFICIENT SAMPLE.
- A5 Instrument stated: stock, or option priced per D-3. A proxy must be labelled.
- A6 Look-ahead: signal bar t, fill t+1 open; every input timestamp ≤ t.
- A7 Neighbourhood: the headline threshold plus its neighbours and other exits. All positive = ROBUST; only the best cell = CURVE-FIT; mixed = FRAGILE (report both, never headline the best).
- **A8 Era split (added):** pre-2022 vs post-2022 means. Sign flip = FRAGILE.
- **A9 Conditional, not fixed-interval (Jamie 11-06):** entry only when the condition matches; close condition + TP + SL + time stop stated; exit-reason mix reported.

## Module B — trade plan (output contract)
Context (fetched price, ATR14, MA distances) · regime (trend/range/climactic, with numbers) · thesis + strongest contrarian case · entry trigger · stop beyond structure (price, %, ATR multiple), **tested, not assumed**: mean-reversion stops often cut winners, so show the backtest with and without · T1/T2 · expectancy E in R with the win rate's source (a backtest row id) · time stop · invalidation · size (risk % of account, $ at stop) · catalysts in window · management · falsifier ("I am wrong if …").

## Module C — when to buy
Fetch first, never recall. Exactly one of ENTER NOW / WAIT (name the trigger) / PASS (what would fix it). Cover pullback and breakout. Pullback level must be below spot. Confluence table (trend MTF, momentum, volume, structure, catalyst) with the count; a verdict against the count says why. Bull and bear case with data.

## Module E — portfolio gate (before any new position)
Inventory · gross/net exposure · short-option collateral · sector % (> 40 % = CONCENTRATED) · correlation clusters (> 30 % = SINGLE-BET RISK; crisis correlation is worse, D-5) · for short options the literal sentence "If everything assigns at once, the account takes $__ and holds __ shares of __ names." Never encode specific personal positions in rules (jamie-rules).

## Worked example — S158 (Claude 11-06, daily bars 2018-10 → 2026-11, 938 tickers, long next open, 5 bp/side)
- A3: daily RSI(14) < 10 = 345 ticker-days but only **41 entries on 25 signal days** (30 large caps: 2 entries). INSUFFICIENT SAMPLE; 10-day hold mean +1.9 % (lift +1.6 pp vs same ticker), but pre-2022 +6.4 % / post-2022 −0.9 % and 20-day −0.7 % → FRAGILE.
- RSI < 12.5 / < 15: mean ≤ 0 at 5–20 days (p5 −28 to −36 % falling knives) — extreme oversold is not reliably a buy.
- RSI < 25 (n 2,682, 760 days): 10-day mean +1.49 % vs same-ticker base → lift **+1.06 pp**, win 59 %, PF 1.45; 20-day lift +1.26 pp. Neighbours 20/30 positive → ROBUST across thresholds, but pre-2022 ≈ 0 (−0.07 %) and post-2022 +1.9 % → era-dependent (A8), and survivorship (D-9) inflates it.
- **Correction (S159, day-clustered):** RSI < 25 lift shrinks to +0.76 pp, t 1.35 → not significant. Trade-level stats overstate when many stocks fire the same day; always cluster by signal day.
- **Rare ≠ untradeable (Jamie 11-06):** rarity is the opportunity. Judge a rare cell by its Wilson lower bound and era consistency, and extend history (LSE daily 2003→, one call per ticker) before calling it. S159: SPY RSI14 < 25 = 17 events in 23 years, 88 % won at 5 d.
- So what: the shallower dip (RSI 20–30) has a real but era-dependent lift; RSI < 10 is too rare on daily bars to trade alone. It needs filters (trend, IV, earnings) via the A359 § 5 factor model, not a lower threshold.
