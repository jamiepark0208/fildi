# Intraday entry timing as a probability model (Jamie 11-10)

**Need (Jamie's words):** "trading is not a fixed if-then deterministic logic, but taking advantage of probabilities… a high risky trade, but we mitigate it by timing execution and taking risk-adjusted bets." Skip the open window; sell puts into intraday lows, calls into highs; win from mean reversion + theta. Urgent: Jamie lost heavily in the Oct–Nov 2026 crash.

**Goal:** for every candidate premium sale, during the session: P(reversion | features now), expected buy-back cost, tail risk → size or skip. No fixed if-then.

## 1. Literature first — DONE 11-10 → research/common/intraday-entry-literature-2026-11-10.md (verify each claim from the paper itself before using it; ≤ 1 page of notes per paper)
Retail names → academic analogs:
- **"Liquidity sweep" / stop hunt** → stop-loss cascades: Osler (NY Fed, 2003/2005) on stop-loss clustering at round numbers and price cascades.
- **"Fair value gap" / imbalance** → order-flow imbalance and price impact: Cont, Kukanov & Stoikov (2014); Kyle (1985) for the impact mechanism.
- **Intraday reversal = paid for providing liquidity** → Nagel (2012) "Evaporating Liquidity": short-term reversal returns rise when VIX is high (= crash tape, the exact regime here). Campbell, Grossman & Wang (1993): volume-driven moves reverse.
- **Open-window volatility** → the U-shaped intraday vol/volume pattern (Wood, McInish & Ord 1985; Admati & Pfleiderer 1988).
- **Intraday momentum vs reversal** → Gao, Han, Li & Zhou (2018) "Market Intraday Momentum"; Baltussen, Da, Lammers & Martens (2021) on hedging demand. These cut against blind reversal on index days and must be features, not ignored.
- **Intraday/overnight return split** → Lou, Polk & Skouras (2019); Bogousslavsky (2021).
- **Option-side timing** → Muravyev & Ni (2020) "Why do option returns change sign from day to night?"; Jones & Shemesh (2018) on non-trading-period mispricing. These cover when selling premium pays.
- Search further (SSRN / Google Scholar, `scripts/fetch-page.sh`): "intraday overreaction", "short-term reversal options", "VWAP deviation mean reversion", "opening range". Log each paper in research/studies/INDEX.md style: claim · sample · effect size · does it survive costs.

## 2. Features (reuse what Fildi has; `.agents/context/indicators.md`, intraday_checkpoint_grades, indicator_grades)
Real-time only (known at that minute): minutes since open · move vs open in ATR · distance to running low/high and VWAP in σ · sweep of the prior-day low/high then reclaim (`prior_day_sweep` already exists) · RVOL / volume climax · RSI/MFI intraday · breadth / SPY-QQQ same-minute move (index vs idiosyncratic) · VIX and VIX term · regime (trend label, Oct-26 = bear) · option side: IV jump vs morning, skew, bid/ask width · earnings/catalyst flags.

## 3. Model + eval (pre-registered before any run)
- Label: from entry minute m, does the stock revert ≥ x·ATR before close / next session before the option's buy-back mark worsens by y? Plus the actual option P&L at the 5-day close / expiry, priced from OPRA (LSE, since 10/2025) at minute m.
- Model: calibrated classifier (logistic / GBM) → P(reversion), with Brier and calibration by regime cell. Gate: beats (a) the job-time entry, (b) "after 60 min, random minute", (c) Jamie's actual fills, at real fill prices.
- Preflight: ≥ 30 independent episodes per regime cell, or the test doesn't run. Holdout = last 6 weeks (the crash).
- Output = per-trade probability + expected P&L + suggested size (fraction of risk budget), not a yes/no.

## 4. Ship
Live: an entry-window panel for Jamie's watchlist showing P(reversion), price now vs the model's good zone, and size. Graded daily by scripts/rec_scoreboard.py (add: an entry-minute column).

## Preflight n (Claude 11-10)
Local watchlist_sync.intraday_bars_1m = 54 names, 2026-08-19 → 11-10 = 2,083 name-days; independent unit = trading day (names co-move in a selloff): bull 33 days / bear (from 10-06) 25 days → **bear cell can't answer at this n**. optlab.minute_bars (2024-10 → 2026-10-16) adds one bull year, no bear. Plan: stock-side label (reversion from the running low, by window) on LSE 1m history for the same names across past bear tapes (2018-Q4, 2020-02→04, 2022) = well over 30 bear days; option P&L at the minute only from OPRA since 10/2025 (bull cell + 25 bear days) → option leg reported as UNDERPOWERED until more bear days accrue; the stock-side P(reversion) model is the part that can be tested now.
