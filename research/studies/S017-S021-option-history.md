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

Loader: `analysis/option_history.py` (resumable; ~15 h at 5 calls/min: underlying → trades → earnings → IV rank).
Universe: trader tickers ∪ book ∪ 30 most frequent Model List tickers (55 names); IV rank = 7 book names (user 10-14 cut).
Storage ~20 MB (bars keep high/close/volume as real; strikes within ±30 % of entry spot).

**Cost haircut, all studies:** option closes are last trades, not fills. Each leg pays half the median bid-ask spread (as % of mid),
by price bucket, measured on `option_chain_history` (Schwab, live). Results are reported with and without it.

## How the data becomes decisions (one engine, one test, one card)

Five studies, but only three pieces of code. Everything else is configuration.

**1. Replay engine** (`analysis/opt_replay.py`). Input: a position (legs = contract + ±qty), an entry date and an exit rule.
It walks the daily bars to expiry and returns: P&L, exit day and reason, capital at risk, and worst mark-to-market along the way.
- S017's exit rules and S020's structures are just (legs × rule) combinations. 935 entries × 5 structures × 5 rules ≈ 23k
  replays, which takes seconds. No per-study simulator.
- Fills, decided now so they can't be tuned later:
  - **Profit-take** triggers on the **close**. Conservative: a resting limit order would often fill earlier.
  - **2× stop** triggers on the day's **high**, filled at 2× premium.
  - **Expiry:** in the money → intrinsic from the stock close (S015: assignment itself is EV-neutral, so the stock leg isn't
    re-modelled here; A92 handles that).
  - **Every leg** pays half the Schwab bid-ask spread (median by price bucket from `option_chain_history`).
- **Stale or illiquid contracts:** a leg with no traded bar on more than 30 % of its days is excluded. The count excluded is
  reported, never silently dropped.

**2. Paired decision test** (`decide(variant, baseline)`). Every comparison is on the **same entries**: variant minus baseline,
per entry.
- Pairing removes stock-picking noise. That matters because we only have ~36 expiry weeks of your trades.
- Unit: **$ per $10k of capital at risk per week**. Freed capital earns the Model List's median weekly yield.
- Confidence interval: bootstrap by expiry week, since breaches move together (S016, ρ 0.6). 90 % CI.
- Also reported: sign in each half of the sample, and worst single week.
- Verdict, one of three:
  - **PASS:** CI excludes 0 and both halves agree.
  - **FAIL:** CI includes 0, or the halves disagree.
  - **NOT ENOUGH:** fewer than 8 expiries or 100 entries (METHODS 9). This is an allowed answer, not a failure to hide.
- Subgroups (regime, IV/RV, earnings in window, cohort) only through an **interaction test**: the difference must itself differ
  between groups. Holm-adjusted across the pre-declared subgroups. This stops "slicing until something wins".

**3. Recommendation card** (one per PASS, written to the report and to `state.md`):
> **Rule** · **Effect** ($/10k/week, CI) · **What it would have changed on your actual 935 trades** ($ total, worst week before → after) ·
> **Applies to** (all / subgroup) · **Cost** (extra trades, spread paid, capital tied up) · **Evidence** (n weeks, n trades) ·
> **Where it shows in Fildi** · **Needs your approval?** (yes if it changes the Model List or scores)

A FAIL gets one line ("tested, no edge: hold stays") so it isn't retried. The counterfactual on your own trades is the headline
number, because "+0.4 %/week" means less than "+$1,240 over Feb–Oct and the worst week goes from −$6.1k to −$3.9k".

**Known limits, stated up front:**
- The sample is your trades: your names, Feb–Oct 2026, mostly a rising market. Conclusions are "for this style of trading in
  this kind of market", and the regime interaction is the check on that.
- Daily closes only, no intraday path, so the stop study is approximate.
- Dividends are ignored, and early exercise is ignored for short-dated puts.

**Per-study specifics** (anything not covered by the engine and test):
- **S018 (earnings)** also uses the engine: your usual put held over the report vs the same z-distance put the following week,
  paired by ticker. The implied-move ratio adds a per-name persistence test (Spearman, previous ratio vs next).
- **S019 (true IV rank)** adds one function, Black-Scholes IV from put closes (vectorized root-find). Then the same `decide()`
  with IV rank as the subgroup, holding IV level fixed (METHODS 2).
- **S021** is a straight join, model premium vs real close, by moneyness bucket.

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
- **Build:** ~30-day ATM implied vol per name per day, by Black-Scholes inversion of the near-spot put's close each day
  (rate fixed at 4.25 %, error < 0.5 vol pt at 30 days; FRED not needed); one contract per month, rolled. IV rank = percentile of today's value over the past 365 calendar days.
  **History minimum (decided 10-15, A111):** the test uses only days with ≥ 120 prior IV points (~6 months); 60 is a
  sensitivity check, not the result. Display shows rank from ≥ 60 points (~3 months; newer names otherwise show nothing) and
  the tooltip says how much history it rests on. Changed from 120 to 60 in 9bee247 without a note; this records it.
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
- **Targets:** P&L per capital at risk (spread: width − credit; CSP: collateral), worst expiry-week loss of the whole book
  (realized, from the replay summed per week; simpler and more honest than re-running the Monte Carlo), and the capital freed
  (spread margin = width), which is what lowers margin-call odds going forward.
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
