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

### P1–P3 approved by the user and shipped (2026-10-05, champion fit-1.4.2, Model List run #13)
Settings in `model_params` (off in SEED so older versions replay unchanged): `thresholds.min_contract_iv_rv` 0.95 (P1),
`premium.contract_iv_pre_earnings` true (P2, Cursor agreed in A28), `portfolio.cumulative_limits` true (P3).
Before/after on identical data: MNDY 75P and NFLX 65P → Review (contract IV 0.90× / 0.87× realized); premium pillar re-scored on contract IV
for pre-earnings expiries (NFLX 68 → 37, TTD 79 → 64, CAVA 18 → 39); sell puts = CAVA 52P ("✓ within your limits: take #1"), DVN 45.5P
("⚠ over your limits": IRA already heavily committed by open puts). Stock-level scores 1.4.1 → 1.4.2 also moved (241 OWN, 31 PREMIUM,
3 verdicts) but from data refreshed since 14:16 (closes → RV/RSI; fundamentals recomputed), not from these settings (the fit never reads them).
Before snapshot: `out/step6/before_fit-1.4.2.json`.

## 12. Capacity and adjustments (user questions 2026-10-05, Model List run #14)
- **Capacity** = cash buying power + collateral on open puts (stock holdings not counted). The 60% `budget_pct` is a soft Step 7 rule (share of
  that cash backing puts at once), not a broker limit: ideas over it stay listed with a warning. IRA today: $38,076 capacity, 39% used; CAVA → 53%, DVN → 65%.
- Closing open puts **is** used, but only when cash is short (feasibility), never to get back under the 60% rule. Selling holdings was **not** considered.
- Shipped (display only, selection unchanged): (a) for ideas over the budget, the share after open puts that expire first and are OTM now
  ("IRA puts drop to 26% after 10/09"); (b) red / risk-flagged holdings in the same account that could fund it, with tax note
  (IRA: none; taxable: gain / loss); (c) an **Adjustments** table per item (OWN via STREET, Prem via P2, wins extrapolated, list moved to Review,
  over limit): from → to, net change, why. New column `model_items.adjustments`, served by GET /api/watchlist/model.
- Fixed: the allocator ignored soft-limit breaches when choosing an account (sent DVN to FILDI at 43% of capacity vs 35% limit); it now
  prefers the account with fewer breaches (closures → breaches → cost → load).
- **Proposals (need approval; would change selection):** C1 the budget rule counts only open puts that are still open at the new idea's expiry
  or are near / in the money (OTM puts expiring first don't block); C2 the allocator may list "sell flagged holding X" as a funding step like
  closing a put (IRA first, taxable only at a loss), still never automatic. No backtest exists for either: they're accounting rules, not signals.
- **C1 approved and shipped (user's version, champion fit-1.4.3, run #15):** open-put collateral counts as closable. Budget measures new
  ideas only (`budget_counts_open_puts: false`); any open put may fund an idea (`fund_by_closing_any_put: true`), and closures that give up a
  better yield or lock in an in-the-money loss are flagged in the funding line, not skipped. Today: DVN "over limit" → "all 2 fit".
- **C2: user wants a richer design** (see the session reply; pending the user's input before building).

## 13. "Explain this pick (AI)" (2026-10-05, run #16)
New explain surface `model-pick` (POST /api/explain/model-pick, `routes/explain.ts`; Haiku, cached in explain_cache per run + item; owner-only).
The server reads the published item (never the client's copy) and turns it into labelled facts; the model only narrates:
why it's listed (incl. pricing label RICH / FAIR / CHEAP), what history says (all-stock rates, $ range, what-if), adjustments (from → to,
UP/DOWN, reason as written), watch / your call (earnings, trend, limits, funding choices only when the model notes them).
Prompt tested on CAVA (sell puts) and NFLX (held back) until 4 errors were gone: FAIR called an edge, earnings timing inverted, invented
"minimal assignment risk", wrong direction on OWN, all-stock rate attributed to the stock. ~950 tokens in / ~330 out per explanation.
This is where the C2 detail lives: funding choices (close a put, sell a flagged holding, tax note) are explained per pick, never automatic.
