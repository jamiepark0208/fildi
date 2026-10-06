**Status 2026-10-05: gate 1 run → STOP on the confidence model and regime dial (`out/proto/gate1.md` §6). Awaiting the user's call on the fallback (§7).**

# Plan: regime detector + Stock score / Trade confidence %, prototype-first (3 gates)
*Rewritten 2026-10-05 (supersedes the same-day "build it" plan). Standalone brief: a reader with no session history can review or execute it.*

## 1. Why
The Model List ranks trades but gives no number the user can act on (size, skip). The scorecard lab (`out/lab/conclusions.md`) showed
which signals are real: options pricing (0.7 · IV/RV + 0.3 · IV rank), long-term trend, and the market variance-premium regime.
Goal: turn only those into (1) a **Stock score** (0–100, how good to own) and (2) a **Trade confidence %** (calibrated: trades
labelled 70% worked ~70% of the time), plus **one market-regime detector**. The user wants proof of benefit before anything
system-wide, so the work is gated: each gate can stop the project at the cost of lab tables and reports only.

## 2. Gates
| gate | what | touches live app | stop / go |
|---|---|---|---|
| **1. Historical proof** (`analysis/proto.py`) | regime labels; ≤ 5 pre-registered regime tests; stock score; confidence % fit 2020-03 → 2023-12, tested 2024-01 → 2026; decision ladder | no (lab tables `watchlist_sync.lab_labels`, `out/proto/`) | user reviews `out/proto/gate1.md` |
| **2. Shadow** (4–6 weeks) | daily confidence % for the real Model List picks written to a lab table; graded by `grade_ledger.py`; not shown | read-only | live reliability consistent with gate 1 (catches plumbing / gross miscalibration only: ~50–100 grades) |
| **3. Display only** | Stock score + confidence % + regime chip in the Model List, user 1 only, behind a flag | Model List (Claude's lane) | user keeps / changes / removes |
| later | system-wide: regime detector read by Cursor's consumers (A26), monthly recalibration in `learn.py`, Scheduled Tasks entry | yes | separate approval |

## 3. Gate 1 design (pre-registered, written before running)
**Trades** (reused, not rebuilt): `backtest_puts.build_trades` + `factor_pca.enrich`: monthly, non-overlapping, 30-day puts and covered
calls priced with Black-Scholes at that day's LSEG IV × 0.85 fill haircut, graded on the real close. Deltas 0.15 / 0.20 / 0.30 so the
confidence % applies to the strike actually recommended (delta is an input).
**Success** = the trade kept money: put P&L > 0; covered call P&L vs holding > 0 (`cc_kept > 0`). Tail = put loss > 5% of collateral.

**Regime labels** (market level, daily, ≤ 3 states each, 5-day confirmation so labels don't flicker):
trend (SPY vs 200-day + 50-day slope: up / sideways / down) · breadth (median stock vs its 52w high: broad selloff ≤ −20%) ·
vol (SPY 30d IV: calm < 15 / normal / stressed > 25) · VRP (SPY IV − 20d RV: rich > 4 / normal / panic < 0).
Acceptance: timeline matches Mar 2020, 2022 bear, Apr 2025, Feb–Mar 2026; few flips per year.

**Regime tests (5, month-clustered: the sample is months, not trades)**
H1 put loss rate by VRP regime (rich < normal < panic) · H2 put P&L by market trend · H3 does IV/RV still rank puts within each VRP
regime · H4 long-term trend vs peers in broad selloffs vs normal (momentum crash) · H5 covered calls on top-quintile 20-day relative strength.
Report every test; t ≥ 3 for anything new; both halves.

**Stock score** = percentile of (long-term trend: 12-1 momentum + distance from 200-day) and analyst revisions (StarMine alpha).
Fundamentals have no point-in-time history (F2) and are left out of gate 1, stated in the report. Weights equal (stated rule, not searched).
Check: beats each part alone on 63-day return vs peers.

**Confidence %** = logistic regression (numpy, L2) per trade type on: delta, IV/RV, IV rank, stock score, regime labels, earnings in window.
Baseline it must beat = training-period success rate per delta (what the strike alone implies).

**Decision ladder** (2024–26, ~0.20Δ puts, top 20 a month by today's PREMIUM):
L0 today's rules (PREMIUM rank + SPY 20-day pause) · L1 + regime dial (skip months the regime marks dangerous) · L2 + confidence
(drop picks in the training-defined bottom fifth of confidence). Metrics: mean monthly return on collateral, loss rate, tail rate,
worst month, months traded; both halves of the test period.

**Stop rules**: confidence Brier skill vs baseline ≤ 0 on 2024–26, or any predicted-fifth off by > 10 pts → no confidence %.
L2 not better than L1 on return *and* tail in both halves → keep the simpler rung. Regime effect in one half only → no regime dial.

## 4. How the user would use it (gate 3 target)
Model List row: `NFLX 65P · 10/31 · Stock 78 · Confidence 84% (hist. 81% of 1,240 similar)`; health strip chip
`Market: uptrend · options rich`. Use: confidence sorts and sizes (e.g. full size ≥ 85%, half 70–85%, skip < 70%), stock score says
whether assignment is acceptable (wheel only above ~60), the chip explains why the list is shorter or more defensive on bad days.
Thresholds come from gate 1, not from this sketch.

## 5. Ops (only if gates pass): reuse, don't add
Daily: `daily.py` model stage writes regime labels; publish stage writes scores (parameters = a `model_params` version, approval-gated).
Grading: `grade_ledger.py` stores outcome against the issued confidence; reliability per bucket. Learning: `learn.py` monthly
recalibration → challenger → shadow → approval; drift → health warning, never auto-change. Monthly lab run in Scheduled Tasks.
Overlaps to settle with Cursor before gate 3: scanner tilt (`model-track-record.ts`, `app_config.model_tilt`) vs `learn.py`;
regime notions (macro cycle stays; VIX bands + SPY pause fold into the detector; intraday banner stays).

## 6. Non-goals
Combination searches, HMMs / jump models, per-stock regimes, new scorecards, Cursor scorecard weights, Robinhood writes, new jobs.

## 7. After gate 1 (2026-10-05): fallback options, awaiting the user
1. **Lookup, not model:** show "historical success for this delta" (e.g. 0.20Δ put ≈ 81–84%) next to each pick, optionally split by PREMIUM
   tier if that split is calibrated on 2024–26 (pre-register before testing). Cheap, honest, needs no regime detector.
2. **Stock score = distance from 200-day percentile** (the only part that beat the composite); fundamentals join when F2 lands.
3. **Tail control for PREMIUM** (its 2024–26 tail rate exceeds the universe's): test a per-sector / per-name cap, pre-registered.
4. Regime work parked; live grades (from 10/09) and `grade_ledger` attribution are the next evidence source.

### Gate 1b result (2026-10-05, `analysis/proto_b.py` → `out/proto/gate1b.md`)
- B1 "wins historically" per delta: **pass** (built 2020–23, off by ≤ 4.7 pts on 2024–26; every delta ran ~4–5 pts higher in the calmer test years).
- B2 split by PREMIUM tier: **keep B1** (no Brier gain; top tier isn't a higher win rate in 2024–26: PREMIUM earns through bigger premiums, not fewer losses).
- B3 tail caps: **both rejected**: ≤ 2 per peer group and "no earnings in window" each cut tail losses sharply in 2024–26 (earnings: tail 8.2 → 5.6%,
  worst month −3.6 → −1.5%) but were worse in 2020–23. Period-dependent; watch via grade_ledger's `event` attribution instead.
- Next (needs user go): display-only Model List change: "wins historically" per delta (full 2020–26 history, with the calm/rough-year range)
  + 200-day trend chip. Static lookup, so no shadow gate needed.

### Gate 1c + display shipped (2026-10-05, Model List run #10)
- `analysis/proto_c.py` → `out/proto/gate1c.md`: win rates for puts / covered calls × Δ 0.15–0.30 × 7 / 14 / 30 days. Every cell within 5 pts
  out of sample (puts ≤ 4.7, calls ≤ 2.2). Per-stock blending **rejected** (real between-stock spread ≈ ±1.7 pts once delta is known).
- `winrates.py` (table `watchlist_sync.win_rates`, versioned, append-only; `refresh` rebuilds only when ≥ 28 days old, ≈ 1 min, $0, no tokens)
  is a `daily.py` publish step. `publish_model_list.py` adds `contract.win` (bilinear on |delta| × days to expiry; live Robinhood delta when
  verified, model delta otherwise; `outside` flag off-grid) and `pillars.ma200` (close vs 200-day).
- UI (display only): Model List detail header "wins 83% (73–87%)" with tooltip; row tooltip; trend line "above/below 200-day (±x%)".
  tsc: no errors in these files (12 pre-existing errors in Cursor's in-progress files). Not yet eyeballed in a browser.

## 8. Enhancement backlog (proposed, not built; cheapest / highest value first)
| # | idea | why | cost | guard |
|---|---|---|---|---|
| E1 | **What-if strike** in the detail view: the same idea at other deltas / expiries ("0.15Δ: wins 87%, premium −40%") | quick adjustment without leaving the app; the table already has the 18 cells | UI + serve the table (one small read) | display only; premium estimate labelled |
| E2 | **Expected $ per contract** = win rate × premium − loss rate × average loss (add average loss per cell to the table) | turns % into money, the number sizing needs | small (table column + one line) | same out-of-sample check (≤ 5 pts / ±10% on average loss) |
| E3 | **Strategy lenses** (Income = PREMIUM first · Wheel = above-200-day first · Defensive = lowest delta first) as sort-only views | scenario/strategy switching without new scores | UI only | sorts existing fields; no new logic (segregation of duties) |
| E4 | **Your record beside history**: Robinhood realized trades at similar delta ("you: 9 of 10") | personal calibration; A24 tie-in | reuse `grade_rh_trades.py` | descriptive, small n shown |
| E5 | **Earnings-in-window chip** | earnings exclusion helped in 2024–26 only; let the user judge, grade_ledger `event` tracks it live | tiny | informational |
| E6 | **One monthly lab command** (lab re-test + win rates + gate checks → one diff summary in Scheduled Tasks) | ops: drift caught without a session | small | report only |
Evidence on adding knobs (precise; corrected 2026-10-05). Tested and failed: regime *skip* rules (gate 1 L1), a fitted confidence % with
regime features (gate 1), per-stock win rates (gate 1c C2), PREMIUM-tier win-rate split (1b B2), technical weight variants (lab `weights.md`).
**Not tested:** regime-based *delta / size* adjustments (only skipping was tested), per-stock *loss severity* or call run-through (HOOD-style
chronic overlay, A22/A24), user-adjustable Model List weights (a UX question, not a predictive one). So: no evidence for more knobs yet,
not evidence against all of them.

### E1 + E2 shipped (2026-10-05, Model List run #11)
- C3 (pre-registered): payout per cell in volatility units passes out of sample (puts lower in 2024–26; calls up to +30%, inside the band).
- Detail view: "Per contract (history): good +$43 · avg +$2 · bad −$59" + a what-if table (Δ 0.15 / 0.20 / 0.30 at the same expiry: strike≈, prem≈, wins, avg $, bad $).
- Honest framing, found while building: the **all-stock average sold option roughly broke even** at realistic fills over 2020–26 (lost 2020–23,
  made money 2024–26). So "avg $" is near zero by construction and the useful parts are the good/bad range and the comparison across deltas.
  Conditioning payout on PREMIUM tier was checked and rejected (top tier paid 30% less in 2020–23, slightly more in 2024–26).
- Payout scales by LSEG ATM IV (as history measured it), not strike IV. What-if premiums ignore skew (labelled ≈).
- Remaining backlog: E3 lenses, E4 your record, E5 earnings chip, E6 monthly lab command.

## 9. Claude ↔ Cursor sync and cross-review (from 2026-10-05)
- Both read this file + `out/proto/gate1*.md` before touching Model List, scanner calibration, or regime code.
- **Overlap to reconcile:** Cursor's `lib/option-scoring/src/calibration.ts` (option-score buckets → live win rate / expectancy, can haircut or
  skip strikes) and this `win_rates` table (historical, by delta × expiry, display only). Proposal: keep both; calibration can use the
  win-rate cell as its prior when live buckets are small. One owner each: Cursor = scanner calibration, Claude = Model List win rates.
- Cross-review: each side lists changed files in ASKS; the other reviews (read-only) and replies "reviewed: ok / issues". First review asks: A27.

## 10. Review of the live picks (2026-10-05, plan #3 → Model List run #12)
| # | idea | fill | Δ | wins (hist.) | $ good / avg / bad | contract IV ÷ 20d RV | 30d ATM ÷ RV (Prem pillar) | trend vs 200d | notes |
|---|---|---|---|---|---|---|---|---|---|
| 1 | CAVA 52P 10/16 | 1.11 | 0.34 | ≈75% | +31 / −12 / −71 | 1.02 fair | 1.14 | −25% | yield comes from taking delta; verdict blank (not "own"); earnings 11/2 (after) |
| 2 | MNDY 75P | 1.06 (model 1.65) | 0.20 | 83% | +34 / −30 / −148 | **0.90 cheap** | 1.03 | −11% | green verdict; RV 72%; IRA puts → 73% of capacity (limit 60%) |
| 3 | NFLX 65P | 0.52 (model 0.62) | 0.24 | 81% | +4 / −31 / −90 | **0.87 cheap** | 1.23 | −20% | 30d IV includes earnings 10/20 that this contract misses → Prem 68 overstates; FILDI 61% in one name (limit 35%) |
| 4 | DVN 45.5P | 0.27 (model 0.55) | 0.18 | 85% | +9 / −9 / −44 | 1.01 fair | 1.02 | +7% | best trend + STREET 82; thin yield (0.37%/wk vs 0.35 floor); IRA → 85% of capacity |
Fixed today: (a) **verify_plan marked in-session quotes "provisional"** (it classified by evaluation time, not quote time); (b) detail view showed
Fildi's modelled premium, not the realistic fill (overstated 17–107%); (c) deltas past 0.30 were read as 0.30 (CAVA's risk understated; now
extrapolated to 0.45 and marked ≈). Side effect handled: a manual `verify_plan.py evaluate` (no --plan) marked draft plan #6 "verified" with
0 passes; restored to draft (21 pending, matching plans 4/5). **Always pass --plan when re-evaluating by hand.**
Judgement: none of today's sized puts sells options priced above recent moves (the validated edge); two sell below. If taking any, DVN
(fair price, best trend, lowest delta) and CAVA (fair, highest fill, but −25% trend and 0.34Δ) are the defensible ones; MNDY and NFLX are cheap.
**Proposals (need the user's approval: methodology changes, before/after shown):**
P1 hold back to Review any put whose contract IV ÷ 20d RV < 0.95 (today: MNDY, NFLX). P2 PREMIUM pillar for ideas expiring before the next
earnings date should use the contract's IV (or IV ex-earnings), not the 30-day ATM IV. P3 the portfolio layer keeps ideas that breach its own
soft limits as "warn"; make the list explicitly cumulative ("take in this order; #3+ exceed the IRA limit").

## 11. Backlog finished (2026-10-05)
E3 strategy views (Model / Safest / Least tail / Rich options / Wheel; sort-only), E4 your Robinhood record per ticker + side, E5 earnings
line (inside window / days after), options-vs-realized line, E6 `monthly.py` (lab + gates + win-rate rebuild every 28 days, ~2 min,
one summary in out/runs/monthly_*.md; replaces the separate win-rate step in daily.py). Earnings coverage: 92 tickers have a next date.
