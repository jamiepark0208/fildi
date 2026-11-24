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

## Order: canonical = Codex's V1–V5 (one numbering only)
Source of truth for each unit's scope, fixtures and acceptance: `research/common/reviews/2026-11-09-opportunity-quality-review.md` lines ~120–132 (§ November 24 follow-up). This file adds only what Codex's units lack. **Supersedes** `research/common/reviews/2026-11-09-critical-feature-repair-plan.md` § 7 (same goal). Don't build from § 7.
| Unit (Codex) | Owner | Claude additions |
|---|---|---|
| V1 close shipped-fix boundaries | Claude | Δ ±0.10 / 35–60 DTE tolerance + "not tested spec" label; CSP same numeric checks; deal pin vs cheap IV; atomic board↔ledger publish (10 Jan calls vs Dec ledger, caused by Claude's --no-log rebuild; no regrade). Crossed/NaN guard already shipped 11-24. |
| V2 repair + publish track record | Claude (API) → Cursor (card) | Start from `research/studies/s205/grade_structures_board.py`; per Structures card show n, real vs predicted, win, ρ, and a "one regime" warning when the grade window has < 2 tape regimes. |
| V3 shared comparison context | Claude | One scenario context per idea shared by every candidate; three lenses (cash, finite-loss, matched downside) + unused cash + stock + no-trade. |
| V4 paired choice evaluation | Claude (research), Codex verifies | Must beat the S179 baseline (and the current-rule / CSP / stock selectors) on held-out episodes, or V5 shows alternatives only. Signal table above = the ideas to cover. |
| V5 surface | Cursor after V3 API contract | Idea row → "Structures for this idea". |
| **S205 repair (not a V unit)** | Codex research, Claude reviews | Real expiry/settlement, causal entry, no-trigger cash arm, real quotes, cost stress; pass = spread beats short put at matched downside in both halves, ≥ 30 episodes. Gates any live panic-day / S172 call spread. Runs in parallel with V1–V2. |

**Reuse, don't rebuild:** S179 (analog→call repricing, failed: baseline), S175 regime structures, `analysis/structure_vec_engine.py`, `analysis/structure_family_engine.py`, S173b / S162 structure grids, `forecast_ledger` identities, A380 scoreboard, `optlab.skew_survey` (now has a ~45 DTE ladder). Before any new study: `oj.py studies "<q>"` + BOARD.md.

Runtime (AGENTS 8c): scenario sets cached per idea per day; no extra Schwab calls (reuse skew_survey); measure ms before/after. Rollback = feature flag on the API field.
