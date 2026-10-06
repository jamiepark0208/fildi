# Watchlist recommendations: plan of record (agreed 2026-10-05)

**Goal:** AI recommendations, delivered as watchlist adjustments, that are deterministic, comparable across all stocks, accountable, and improving.
**Rule:** test in the Fildi app (Watchlist → **Model List**) first. **Nothing is written to Robinhood** until the user promotes it.
**Pace:** step by step. Each step ends with a verification against outside data before the next one starts.

## Framework (user's design)
1. **Scorecards = the deterministic base.** Fundamentals, Technicals and Options: one framework applied fairly to all (or most) stocks, so any two can be ranked against each other.
2. **Differentiation = rewards and penalties** on top of the base. They can be general, per sector or per stock. Example: STREET (analyst revisions, predicted surprise, PT) is a reward/penalty layer, not a fourth base scorecard, *pending the scenario analysis in Step 2*.
3. **Accountability + learning:** every recommendation is graded, and the system works out *why* it was good or bad. That feedback adjusts the methodology: (a) general weights, (b) new factors or metrics, or (c) specific rewards/penalties. Every change is shown as a before-vs-after score comparison and scenario analysis, and the user approves it.

## For Cursor: your role in this plan (read before acting on A12–A14)
**Why you matter most:** everything rests on the base scorecards (fundamentals, technicals, options), and those are your lane. Claude's layers (rewards/penalties, verdicts, lists, grading) can only be as good as your inputs and scores. The learning loop will route its findings back to you in two forms:
- **Data errors** (stale prices, stale spot, Yahoo IV/bid artifacts): filed as bugs in ASKS.md. These are *never* used to retune weights, because learning from a data bug teaches the model the wrong lesson. So data integrity is the highest-leverage work.
- **Method proposals** (weight changes, new factors, specific rewards/penalties): sent with a before/after score comparison and scenario analysis. **The user approves**, then you apply them in the scorecard code / versioned weights. Claude never edits base scorecard code; you don't edit verdict/grading logic.

**Design rules to preserve** (please flag in ASKS.md instead of changing these silently):
1. Scorecards are deterministic and peer-relative: the same formula for every stock in its peer group.
2. Point-in-time and append-only: every score is saved with as_of, inputs, component scores, coverage/confidence and model_version. Never overwrite history (backtests and grading depend on it).
3. Missing data lowers confidence; it never makes a stock look clean.
4. Weights live in one versioned place, so a change can be compared, shadow-tested and rolled back.
5. Model tags stay in `watchlist_sync.*`, never in `watchlist.color_tag`, so they can't feed TAG_BONUS / the scanner (a self-reinforcing loop) or overwrite the user's own tags.
6. Nothing goes to Robinhood until the user promotes the Model List after a graded track record.

**Cursor's A15 pushbacks, accepted 2026-10-05:** (1) fund totals may be *null* when coverage/safety gates fail (coverage < 0.4 or safety_coverage < 0.15), and soft-peer/speculative/safety guards change effective weights. Fine, as long as null is treated as "unknown", never as clean. (2) The versioned weights table doesn't exist yet (weights live in `fund-score-engine` code), so it's a **prerequisite for Step 6**. (3) STREET stays out of the fund base until the Step 2 evidence. Snapshot contract (A14): per-lane tables with a shared row shape (ticker, as_of, lane, total, components, coverage, confidence, peer_group_id, model_version, inputs_digest, trigger, computed_at); tech/options mirror `fund_score_snapshots`.

**What's coming to you next:** Step 2 asks you to document each scorecard: inputs, weights, coverage, where it's persisted, known weaknesses. Step 3/4 backtests will show which components actually predict outcomes. Expect proposals after that, not before.

**Check your understanding (reply in ASKS.md, new row Cursor → Claude):** in ≤6 lines, restate (a) the goal, (b) what your lane owns vs Claude's, (c) how a weight change flows from finding → approval → code, and (d) how your `fund_score_snapshots` / `fund_score_notes` accountability work relates to this plan, including any overlap or disagreement. Push back if any rule above conflicts with how the scorecards actually work.

## Duties (segregated)
| Lane | Owner | Never does |
|---|---|---|
| Data integrity (inputs, freshness, confidence) | Cursor (app data) + Claude (LSEG) | judge stocks |
| Scorecards (base) | Cursor builds; formulas signed off by user | grade itself |
| Rewards/penalties + verdict (fit model) | Claude | change base scorecard weights directly |
| Portfolio fit (collateral budget, sizing, caps, cost basis, regime) | Claude, limits set by user | |
| Verification (L1 Fildi, L2 live RH) | Claude, independent of model tuning | tune the model |
| Grading + attribution + factor research | Claude (separate module from the model) | apply its own proposals |
| Weight/method changes | proposed by grading → **approved by user** → applied by scorecard owner via versioned weights | |
| Apply (app Model List now; Robinhood later) | Claude, ask-first, logged, kill switch | |

## Attribution: why a rec was good or bad
Each graded outcome is split into: market/sector move · event (earnings gap, news) · **data error** (sent to the data lane as a bug, *never* used to learn from) · factor error (which components pointed the wrong way) · luck (right setup, bad draw). Only factor errors, plus events a feature should have caught, drive adjustments. Lessons seen across several stocks become general features (TTD's earnings crashes → an "earnings-gap history" feature for everyone). Stock-specific adjustments must clear a minimum sample size, are shrunk toward the sector, and decay unless re-confirmed. New weight sets run in shadow beside the live set (champion/challenger) before promotion. Every version is logged and reversible.

## Data for backtests (verified 2026-10-05, not lost)
| Need | Source | Depth |
|---|---|---|
| Daily ATM implied vol, 30/60/90d, put + call | LSEG `<TICKER>ATMIV.U` RICs (`get_history`, one request per ticker) | ≥ 2023-01 (TTD/NFLX/SOFI checked, ~870–930 rows) |
| StarMine combined alpha, predicted surprise | `lseg_research.starmine_history` | 2018-10 → now, 105 tickers |
| Daily prices | `prices_historical` 2025-04 → now (but see A12: 53 names stale since July); CRSP via WRDS to 2024-12 | |
| IBES revisions/surprises | WRDS (Cursor lane) | multi-year |
| Option chains / OptionMetrics | **not available** (WRDS sample only) | |
→ Option-selling backtests are reconstructed by pricing each trade from that day's ATM IV, applying the realistic-fill haircut observed on Robinhood (16–35%), then following the stock's real path. ATM IV understates OTM put skew, so modeled premiums run low, which errs on the safe side.

## Steps
| # | Step | Status |
|---|---|---|
| 1 | **Model List harness:** app tabs *My List / Model List*, folders like RH lists; verdict ≠ role (held names show their real verdict); verdict cross-check on trade ideas; append-only runs + fit-score ledger | **done 2026-10-05** |
| 2 | **Scorecard audit + STREET due diligence:** inventory what each scorecard computes; scenario analysis of STREET as base pillar vs reward/penalty vs excluded, with before/after rank comparisons on the 265-name universe | **done 2026-10-05** → `out/step2/` (fit-1.4 proposal awaiting user approval) |
| 3 | **Historical data pull:** LSEG coverage gap closed (model tier, 150→300 cap, 32 RICs; missing credit 31→1). `lseg_research.daily_history` (close + 30/60d ATM IV from 2020; TTD IV goes back to 2017). StarMine + earnings history backfill for the new names | **done 2026-10-05**: batched + resumable + split-aware history sync, monthly datapoint guard, per-ticker StarMine watermarks + negative cache, earnings reuse stored prices (191 → 1 request), generic split repair for prices_historical |
| 4 | **Backtest engine + factor research:** `analysis/backtest_puts.py` (monthly ~0.20Δ 30d puts, BS at LSEG IV, validated vs live RH quote: $0.53 vs $0.525 mark, Δ exact) | **v2 done 2026-10-05** → `out/step4/conclusions.md` (risk-adjusted / premium-kept / 63d-vs-peers targets; robust across delta + haircut) |
| 5 | **Grading + attribution** of the live ledger (model runs, plan items, model_recs) at 5d/10d/expiry | `grade_ledger.py` built (market/event/data/factor/luck); first expiries 2026-10-09 |
| 6 | **Learning loop:** proposals with before/after + scenario report → user approval → versioned weights; champion/challenger | **live for Claude's layer 2026-10-05**: `params.py` (versioned params, champion fit-1.4.0 = user-approved), `learn.py` (evidence → bounded, seed-anchored, idempotent challenger + before/after; first challenger fit-1.4.1), wired into `daily.py`. Base scorecards need Cursor (A17) |
| 7 | **Portfolio fit layer:** total collateral budget across the list, sizing caps, sector caps, cost basis on calls, regime pause, exit/roll watch | **done 2026-10-05**: `portfolio.py` (shared budget per account, position + sector caps, no stacking puts, calls ≥ cost basis, Manage folder: take profit / at risk / expiring) + regime pause; all limits in `model_params.portfolio` (learnable once live grades exist) |
| 8 | Verification fixes: re-price at RH realistic fill (not "≥85% of Fildi"), in-session timing | **done 2026-10-05**: realistic-yield rule; floor 0.35%/wk realistic ≈ scanner 0.50%/wk Yahoo (`thresholds.min_weekly_realistic`); cheap pre-check before quotes (13 → 7); deterministic `rh_client.py` (MCP OAuth, read-only allowlist, Keychain) replaces manual/AI fetching |
| 9 | Promote to Robinhood (Phase 2 apply) only after the Model List has a graded track record | waiting on a graded track record (first grades 10/09–10/12); user decision |

## Gap register (from the 2026-10-05 review) → where it lands
#1 lists vs tags contradict → Step 1 cross-check ✅ · #2 collateral per-idea → Step 7 · #3 history overwritten → Step 1 ledger ✅ · #4 manual vs model tags → Step 1 (model tags live apart from `watchlist.color_tag`) ✅ · #5 role vs verdict → Step 1 ✅ · #6 TAG_BONUS loop → avoided while model tags stay in `watchlist_sync` · #7 missing data = clean → Step 2 confidence · #8 earnings IV in premium → Step 2/4 · #9 mixed IV/RV sources → Steps 2–3 · #10 EDGE unused → Step 4 (test as a factor) · #11 thresholds untested → Step 4 · #12 85% fill gate → Step 8 · #13 after-hours trigger → Step 8 · #14 ticker vs contract → Step 9 (RH option watchlist) · #15 cost basis → Step 7 · #16 exits/regime → Step 7 · #17 frozen universe → Step 3 · #18 (new) plan and fit universes differed → fixed in fit-1.3 ✅ · #19 (new) stale prices for 53 names → A12
