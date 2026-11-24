# Structure selection: integrated plan (Claude + Codex, 11-24)
> Jamie 11-23/24: "is Fildi able to consider best trade option structures, not just selling puts/calls?… make the structures tab more accurate for each strategy." Jamie approved the build (no further ask). Owners: **Claude = production logic**, Codex = isolated research + independent verification, Cursor = one claimed UI slice after the API contract is fixed. Rows: A192 (build), A205 (handoff/verify).

## What we know (both analyses)
**Claude (S205 Parts A+B, `research/studies/s205-panic-day-calls-vs-puts.md`):**
- Board EV = the stock's own 2-y returns de-meaned → vol-vs-history only; no directional signal enters it. Rank ρ pred→real ≈ 0 in 9/14 structures; long-call primary +71 % pred → −78 % real (one falling month: read ranks, not signs).
- S076 unconditional badges make conditional winners "study only"; CSP claims every ticker first; EV units differ (% debit vs % cash strike).
- Panic day (VIX ≥ 30, inverted, ≥ 7 % off 20 d high), SPY n 34: naked call +11.5 % / median −17 %; call spread +27 %; 5 % OTM short put +1.2 % cash 85 % win (**research lead only**: see Codex #4).

**Codex (A192 11-24 #1–5, packet `research/common/reviews/2026-11-09-opportunity-quality-review.md` § November 24 follow-up, V1–V5):**
1. 45 DTE long-call fix verified, but stored Δ 0.462–0.798 and silent 24 DTE fallback → needs spec-match tolerance + "not the tested spec" label, no auto S100 badge.
2. Crossed quotes / NaN IV passed `_tradable` → **fixed 11-24 (this commit)**; still to do: same numeric checks on the CSP path; separate "deal pin (model can't apply)" from "genuinely cheap IV".
3. Ledger mismatch: 10 primary January calls vs ledger's December rows (Claude's `--no-log` rebuild caused it) → atomic board/ledger identity, keep superseded intraday publications, no retroactive regrade.
4. S205 not promotion-ready: 3 SPY / 2 QQQ 20-session exits fell after the synthetic 30-day expiry; 5 %/leg cost stress cuts spread +27 → +10.6 %; same-notional ≠ same-risk; 1,765 board rows are not independent trades; quarantined >60 % moves need sensitivity.
5. **S179 already failed** (historical analogs → repriced current calls: no ranking/Brier lift). Don't rebuild a call predictor; the new question is **paired structure choice per idea** on one shared scenario set.

## Merged decision
Build "best structure per idea" as a **comparison**, not a new score: for an idea a tested signal flags, price every eligible structure on the **same** scenario paths, horizon, quote snapshot and event assumptions, and show three lenses: **cash budget, finite-loss budget, matched downside**, plus unused cash, a stock leg and no-trade. When the lenses disagree, show the alternatives rather than one "best". Scenario source = the firing study's realized episodes (S179 = baseline it must beat).

| Signal (study) | Compare | Constraint |
|---|---|---|
| Revisions + sustained strength (S100 / ARM) | shares, call, call spread, short put | validate live ARM substitution; cheap-IV gate didn't help every angle |
| Market fear subsiding (S172 / S197) | index call, spread, short put, shares | index evidence ≠ crashed single name (S177) |
| Ongoing broad panic (S205 / S177) | call spread, call, short put, wait | repair S205 timing/cost/episodes first (Codex #4) |
| Prior-low reclaim (S191) | short put, put spread, shares / limit buy | put-sale evidence ≠ call evidence |
| Quiet before expansion (S154 / S203) | straddle/strangle vs alternatives | evidence thin + intraday → no swing rule |

## Order (one at a time; each = commit + Codex verify)
- **V1 (Claude, small): accuracy floor.** Spec-match tolerance (Δ ± 0.10, DTE 35–60) + label unmatched as "not tested spec"; CSP gets the same numeric checks; deal-pin vs cheap-IV split; atomic board↔ledger publish (fixes #3). Accept: Codex's V1 fixtures + 0 ledger/board mismatches on the next nightly.
- **V2 (Claude): per-structure realized grade** (generalize `research/studies/s205/grade_structures_board.py`: unique contracts, actual expiry settlement, episodes clustered by date, quarantine list) → table `structure_grades` → API field on `/api/options/structures`. **Cursor:** show it on each Structures card (n, real vs predicted, win, ρ, "one regime" warning when < 2 tape regimes).
- **V3 (Codex research, Claude reviews): fix S205.** Real expiry/settlement, causal entry (next open / close-of-signal executable), same event universe with a no-trigger cash arm, real quotes where LSEG/OPRA has them, cost stress. Pass bar: spread beats short put **per matched downside** in both halves, n ≥ 30 episodes.
- **V4 (Claude): paired comparison engine** for the signal table above: one scenario hash per idea, three lenses, S179 baseline must be beaten on held-out episodes (calibration + choice regret) or it ships as display-only alternatives.
- **V5 (Claude + Cursor UI): surface it.** Idea row → "Structures for this idea" (3 lenses + stock/no-trade); panic-day/S172 index call spread as a live strategy only if V3 passes.

Runtime (AGENTS 8c): scenario sets cached per idea per day; no extra Schwab calls (reuse skew_survey); measure ms before/after. Rollback = feature flag on the API field.
