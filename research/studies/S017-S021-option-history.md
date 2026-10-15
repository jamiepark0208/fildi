# S017–S021 — what real option price history can answer (pre-registered 2026-10-14, Claude PM)

> User 10-14: approved exit rules, earnings, true IV rank, structures (spreads / straddles / strangles) and the cheap extras.
> "Don't limit the conclusion to Polygon" → every study joins the option prices with the rest of Fildi (below).
> Written **before** any result was looked at. A failed stop rule ends that study (METHODS 8).

## Data

| Piece | Source | Where |
|---|---|---|
| Option daily closes (last trade, EOD), 2024-10 → now | Polygon free `/v2/aggs/ticker/O:…` | `optlab.bars` (+ `optlab.legs` = which contract plays which role) |
| Strike lists per expiry | Polygon `/v3/reference/options/contracts?expired=true` | `optlab.contracts` |
| Unadjusted stock closes, 2 y (prices_historical starts 2025-04) | Polygon aggs `adjusted=false` | `optlab.underlying` |
| Trader's 935 short puts (Feb–Oct 2026) + features | S015 | `out/mistakes/trades.csv` |
| Live chains with bid/ask/IV/delta (from 10-08) | Schwab | `option_chain_history` |
| Earnings dates, EPS estimate/actual/surprise | Finnhub/AV | `earnings_calendar` |
| Regime, VIX bucket | Fildi regime engine | `market_regime` |
| Short interest history | Polygon (S-I panel) | `short_interest_history` |
| Book stress (margin call / assignment > cash odds) | pm_book + pm_alerts Monte Carlo | `scripts/watchlist_sync/pm_alerts.py` |
| Guidance direction / tone per call (forward only) | transcripts.py | `watchlist_sync.earnings_transcripts` |
| StarMine predicted surprise, EPS dispersion (forward only, from 10-04) | LSEG | `lseg_research.signals_daily` |

Loader: `analysis/option_history.py` (resumable; ~35 h of calls at 5/min: underlying → trades → earnings → IV rank).
Universe: trader tickers ∪ book ∪ 30 most frequent Model List tickers (55 names).

**Cost haircut, all studies:** option closes are last trades, not fills. Each leg pays half the median bid-ask spread (as % of mid),
by price bucket, measured on `option_chain_history` (Schwab, live). Results are reported with and without it.

## S017 — Close early or hold? (claims the "Exit rules" row)
- **Question:** for weekly short puts, does a pre-set exit beat holding to expiry?
- **Rules (only these five, fixed now):** hold · buy back at 50 % of premium · at 75 % · stop at 2× premium · close the day
  before expiry if in the money.
- **Target:** P&L per collateral-week. Capital freed early earns the Model List's median weekly yield for the remaining days
  (`model_recs.weekly_income_pct`), so an early close isn't credited with idle cash.
- **Fildi strata (pre-declared, reported, not mined):** regime bucket, IV/RV at entry (S003), earnings in window, IV-implied
  P(ITM) at entry (S016), days to expiry at entry.
- **Stop rule:** a rule replaces "hold" only if it beats hold in both halves of the sample, with a (ticker, week) cluster-bootstrap
  90 % CI excluding 0, after the spread haircut. Otherwise hold stays and the study closes.
- **Where it shows if it passes:** the Book card / Expiry desk ("buy back now: rule hit") + one Portfolio Alerts bullet.

## S018 — Earnings: implied vs realized move
- **Question:** per name, is the earnings move the options price in too big (sell through it) or too small (skip / hedge)?
- **Measure:** implied move = ATM straddle close the day before ÷ spot; realized = |close after ÷ close before − 1|.
  Ratio = realized ÷ implied per event, plus the P&L of the trader's usual put (strike at the same z-distance) held over the event.
- **Fildi joins:** EPS surprise size (`earnings_calendar`), short interest before the event, regime, and forward-only
  (display, no backtest yet): StarMine predicted surprise, EPS estimate dispersion, last call's guidance direction.
- **Stop rule:** persistence first. If a name's past ratio doesn't predict its next ratio (Spearman across names, |t| ≥ 2, both
  halves), there are no per-name flags: Breakdown shows the history only. Per-name flags need ≥ 4 events.
- **Where:** Breakdown › Earnings calls tab (moves table + chart); Model List "earnings in window" row gets the name's ratio.

## S019 — True IV rank
- **Build:** ~30-day ATM implied vol per name per day, by Black-Scholes inversion of put closes (rate = 3-month T-bill from FRED),
  interpolated between the near-spot strikes we stored. IV rank = percentile of today's value over the past 252 days.
- **Validation gate:** on overlap days (10-08 onward) the built IV must match Schwab chain IV with correlation ≥ 0.9 and median
  absolute error ≤ 3 vol points. If it fails, stop here.
- **Question:** does true IV rank carry what S004's "IV rank" was meant to carry? (Today `technicals-math.ts` ivRank is a
  realized-vol rank.) Compare true IV rank vs RV rank vs IV/RV on trader puts + S003 reconstructed puts, IV fixed, placebo.
- **Stop rule:** METHODS 6 pass marks. A score change needs the before/after and user approval; display can ship either way
  (true IV rank on Breakdown + Model List, labelled correctly).

## S020 — Structures: spreads, strangles, straddles
- **Same entries as S017** (trader's 935 puts; Model List recs added as they accrue). Variants on each entry:
  cash-secured put (baseline) · put spread 1 and 2 strikes wide · short strangle (sold put + call mirrored around spot) ·
  short straddle (ATM put + call). Iron condors need call wings we didn't fetch; added only if a spread passes.
- **Targets:** P&L per capital at risk (spread: width − credit; CSP: collateral), worst expiry-week loss, and the book stress the
  structure would have left: replay each week through the pm_alerts Monte Carlo (P(margin call), crash-budget drawdown).
- **Fildi strata:** name class (speculative / pre-revenue / profitable from fair-value cohort), regime, IV rank (S019 if it passes),
  earnings in window (S018).
- **Pass mark (from the pre-registered row):** a spread is offered for a name class if its worst week is lower while keeping
  ≥ 70 % of the premium per capital. Strangles/straddles must beat the CSP on P&L per capital *and* not raise the worst week.
- **Where:** the Model List gets a "structure" column (CSP / spread with width) for passing classes; the pm_book handles spreads
  as defined-risk legs (Cursor).

## S021 — Were S003's reconstructed puts priced right?
- S003 priced 17k historical puts with a model. On contracts both cover (2024-10 → 2026), compare model premium vs real close.
- **Pass:** median absolute error ≤ 20 % of premium and no bias by moneyness bucket. Fail → every S003-derived conclusion gets a
  caveat in INDEX and is re-run on real prices where possible.

## Cheap extras (display, no study) → A96 (Cursor)
Market breadth from Polygon grouped daily (1 call/day), A87 price gaps, ex-dividend warnings on short calls, daily short volume
next to short interest.
