# Next session: watchlist recommendations (handoff, updated 2026-10-05)

**Read first:** `PLAN.md` (plan of record, the user's framework, segregated duties, steps, gap register) → `README.md` → open rows in `research/common/ASKS.md` (A12–A14 are new).
**User wants:** step by step, safe; test in the Fildi app's **Watchlist → Model List** tab; **no Robinhood writes** yet. Every methodology change needs before/after score comparisons and scenario analysis.

## Done 2026-10-05 (Step 1)
- App: Watchlist has **My List / Model List** tabs (`pages/watchlist.tsx`, `components/model-list-panel.tsx`, `hooks/use-model-list.ts`, `GET /api/watchlist/model` in `routes/watchlist.ts`, user 1 only, read-only).
- `fit_model.py` → **fit-1.3**: verdict separate from role (6 of 10 held names are red: MP, OPEN, REBN, USAR + 2), plan tickers always scored (265), append-only `fit_score_history`.
- `publish_model_list.py` → run #1 (280 items, 10 folders). Cross-check held TTD 11.5P back (ARM 1/100); RIG 5P, NFLX 65P, POET 8.5C are provisional (after-hours L2).
- Found: LSEG serves **daily 30/60/90d ATM IV history ≥2023** (`<T>ATMIV.U`), so option backtests are reconstructable. **53 names have stale prices** since July (A12).
- Not verified: Model List visually in a browser (no session cookie here); API SQL + tsc + Vite compile are verified.

## Step 2 done 2026-10-05 → `out/step2/scorecard_audit.md`, `out/step2/street_scenarios.md`
Baseline pinned without commits: `out/baselines/step2_20261005/manifest.json` (file hashes + copies). Fit re-run on A12-fixed prices changed 8 verdicts.
**Awaiting user:** approve fit-1.4 (STREET gate → ±10 reward/penalty, keep STREET flags, hard floors) and decide the red rule separately.

## Later on 2026-10-05 (Steps 3/5/8 + fit-1.4 shadow)
- LSEG coverage: `model` tier + cap 300 → 256 names; 32 RICs resolved and price-validated; missing credit 31 → 1. Signals refreshed in session (14:43 ET).
- `lseg_research.daily_history` (`research/lseg/sync_daily_history.py`): 256 tickers, 396k rows (IV on 351k), mostly 2020→2026-10-02 (TTD from 2016). Cross-checked vs prices_historical: matches except GOSS, where **Fildi is wrong** (unadjusted 80:1 reverse split, A16; Robinhood confirms LSEG). Use daily_history for backtests.
- Plan #3 verified on live quotes; L2 now judges realistic weekly yield (2 → 9 passes); Model List run #3 published.
- `fit_model_v14.py` shadow rows written (`fit-1.4-shadow`): missing-data policy, scaled STREET (convex), severity red. Report `out/step2/fit_v14_shadow.md`. Not promoted. Open calibration: green 37 → 58, energy-clustered STREET rewards (test sector-relative).
- Built, not yet run on full data: `analysis/backtest_puts.py` (BS pricing validated vs live RH NFLX 65P), `grade_ledger.py` (first expiries 10/09).

## Done later on 2026-10-05 (same session)
- **One command:** `daily.py` (lseg → integrity → model → verify → publish/grade), logs in `out/runs/`. Stops at Robinhood L2 for a Claude session.
- **LSEG framework:** batched (20 RICs/request), per-batch commits, per-ticker watermarks, negative cache (`lseg_research.fetch_attempts`),
  monthly datapoint guard (`lseg_research.usage_daily`, stop at 80% of 10M), 4-byte floats (46 → 37 MB), benchmark ETFs tier.
  `purge.py` drops the whole schema, so license deletion still covers everything.
- **Splits, generic:** sync_daily_history re-reads 5 overlap days and re-fetches a ticker's history on any basis change (tested by simulating a 1:2).
  `split_repair.py` repairs prices_historical from two sources (backup + `price_repairs` log + Cursor's technicals recompute). First run: GOSS 80:1 repaired, 0 false positives on 570 tickers (A16).
- **Step 4 v2:** `out/step4/conclusions.md`. Proposed (not applied): PREMIUM = IV/RV 70% + IV rank 30% (drop raw IV), keep STREET raw as a modest reward
  (strongest for green), keep the earnings block, cut falling-knife severity 0.5 → 0.2, regime pause in broad selloffs.

## Step 6 done 2026-10-05 (same session)
- Champion **fit-1.4.0** (user approved the Step 4 proposals) drives the Model List (run #4). Challenger **fit-1.4.1** from the first
  learning cycle: premium 0.673/0.327, STREET k 8 → 10, falling knife 0.2 → 0.15 (1 verdict change: HOOD → yellow). Waiting for user approval.
- `learn.py status | propose | promote V --approve | retire V`. Proven idempotent (same evidence → no new challenger) and convergent.
- Live grades join the evidence after 10/09 expiries; thresholds only move on live grades (≥ 30 per folder).

## Step 7 + delegation done 2026-10-05 (same session)
- User delegated routine decisions: Claude promoted **fit-1.4.1** (champion); `learning.auto_promote` on, bounded by 25%/param and
  ≤ 10% verdicts changed. Bigger moves, new methodology and anything touching Robinhood still go to the user.
- `portfolio.py` + publish: Model List run #8. Sell Puts = CAVA 52P ×1 + MNDY 75P ×1 (IRA, $12.7k of a $13.9k budget); NFLX/DVN don't fit
  FILDI's cash budget/position cap; POET 8.5C held (below $9.41 cost); Manage: take profit on ONDS 7P (both accounts) and USAR 12.5P.

## Portfolio v2 + Cursor A18 (same session)
- User corrected the budget: it now counts collateral already posted and can fund by closing weaker open puts; limits are warnings.
  Run #9: CAVA 52P + MNDY 75P + DVN 45.5P (IRA), NFLX 65P (FILDI), all provisional (re-verify in session); limit badges where breached.
- Cursor's A18 findings all verified; reply in A19. Their order: scorecard_params → tech snapshots → option snapshot fix → fund snapshot cols → IBES 2020+.

## Efficiency review (same session)
- Fixed: grader counts only the last Model List run per day (9 runs on 10/05 would have been graded 9×).
- Fixed: `verify_plan.py requests` pre-checks verdict / cost basis / fundability first (plan #3: 13 → 7 contracts to quote). `--all` skips it.
- To do: merge fit-1.3 into fit-1.4 (1.4 loads its own inputs; retire 1.3 + fit_scores color tags); run learn.py weekly or on new grades;
  Haiku helper for the Robinhood quote fetch.

## Consolidation done 2026-10-05 (same session)
- Cursor A20 verified (scorecard_params + A14 snapshots + day-wipe fix). A21 reply: EQR via LSEG fallback; AVB is acquired/inactive since
  2026-08-14 (deactivate); IBES needs more `--universe coverage` batches (user Duo each).
- One fit model; learn.py only on new evidence; grader one run/day; quotes pre-checked (13 → 7); `rh_client.py` deterministic quote fetch.

## Daily operation (final, 2026-10-05)
- The existing ask-first Robinhood export (dialog after the close → Claude session, `~/rbh_scripts/COLLECT_PROTOCOL.md`) now ends with
  **Step 13** (`daily.py --until model` → `verify_plan.py requests` → read-only quote fetch for ~5–15 pre-checked contracts → ingest) and
  **Step 14** (`daily.py --from verify`: evaluate → publish Model List → grade → learn if new evidence). One click per day keeps the
  Model List current. No Robinhood writes; no new login.
- LSEG is soft: if Workspace isn't running, the pipeline continues on the last synced data (logged in out/runs/).
- L1 now uses put capacity (free + posted) like portfolio.py, and falling knife is a warning (champion severity decides).
- `rh_client.py` is OPTIONAL (deterministic read-only MCP client; would need a one-time OAuth login). Only worth it if the user wants the
  whole Robinhood pull deterministic/unattended instead of the Claude export session.

## Closed out 2026-10-05
- Model List **health strip** (export · quotes · LSEG · prices · grades · model version · splits fixed; green ≤1 day, amber ≤3, red older),
  from `health` in GET /api/watchlist/model. Manage folder opens by default.
- **Render verified** without a browser: the real ModelListPanel server-rendered through Vite with live DB data (header, health strip,
  11 folders, sized puts "52P 10/16 ×1 · IRA", prov/limit/review/H badges, Manage rows all present). User hasn't eyeballed it yet.

## NEXT SESSION: execute `PLAN_next_session.md` (regime detector + calibrated Stock score / Trade confidence %)
Regime detector owner = Claude (user decision, ASKS A26). Cost/benefit review chose calibration over large pattern searches; see the plan's non-goals.

## Gate 1 prototype done 2026-10-05 (latest) → `out/proto/gate1.md` §6, `analysis/proto.py` (22 s, read-only + `watchlist_sync.lab_labels`)
- Plan rewritten prototype-first (`PLAN_next_session.md`, 3 gates). Gate 1 verdict: **stop** on the fitted confidence % (Brier skill −6% puts,
  −2% calls vs the delta's own success rate) and on a regime "skip" dial (cost 0.13%/mo, no tail benefit; downtrend months were *good* for puts).
- Kept: PREMIUM ranking works (top 20 beats all names in both periods); stock-score trend part = distance from 200-day alone.
- Gate 1b (`out/proto/gate1b.md`): delta lookup passes; PREMIUM-tier split and tail caps rejected (period-dependent).
- Gate 1c + display shipped (run #10): `winrates.py` (monthly refresh in daily.py), contract.win + pillars.ma200 in the Model List detail view.
- E1 what-if strike + E2 $ per contract (good/avg/bad) shipped in run #11 (PLAN §8). Avg sold option ≈ break-even across all stocks; edge = selection.
- **Next:** Cursor review via ASKS A27; remaining backlog E3–E6. A25 → user takes it to Cursor.
- Not verified: the new fields in a browser (no session cookie here).

## Scorecard lab + Step 8 done 2026-10-05 (late session)
- **Step 8** (`out/step8/conclusions.md`, `analysis/factor_pca.py`): PCA + scenario study of what makes a put / wheel / covered call good.
- **Scorecard lab** (`out/lab/conclusions.md`): live technical engines replayed 2020→2026 (`artifacts/api-server/src/scripts/lab-replay-technicals.ts`),
  outcomes/features store (`analysis/lab_outcomes.py`, `analysis/lab_fund_features.py`), grader (`analysis/lab.py`, 2 s cached). Full re-test ≈ 1.5 min.
- Headline: technical totals (v2, v4) predict nothing; only long-term TREND passes; Volatility State is really options pricing; options PRICING
  (0.7 IV/RV + 0.3 IV rank) passes everything; IBES revisions ≈ trend; SUE no edge; quality/value/growth/safety untestable (no filed-date history).
- Live drift bug found: technical percentiles use all stored bars → backfills change live scores (A25 T1).
- **Waiting on the user:** approve A25 proposals (T1–T4, O1–O3, F1–F2, M1–M2) and decide the regime-dial owner (R1). Then: M1/M2 in the Model List,
  RH tiers → learn.py (A24) on the validated targets. Single factor map: `FACTOR_MAP.md`.
- LSEG: daily_history now has high/low/volume 2018-10→ (271 names), 4.3M of the 8M monthly guard used this month.

## Next session = the user's new ask. Background facts:
- Daily: the Robinhood export click runs COLLECT_PROTOCOL Steps 13–14 → Model List refreshes. First live grades 10/09–10/12.
- **Claude lane (A24):** wire RH historical tiers (`analysis/grade_rh_trades.py` → premium_kept) into `learn.py` evidence; per-stock rare (HOOD CC chronic). User working with Claude.
- **Cursor lane (parallel):** Settings → Scheduled Tasks inventory + duplicate/drift detection UI (not learn.py).
- Cursor open: IBES `--universe coverage` batches (user Duo). Step 9 (Robinhood writes) = user's call later.
- Ideas backlog: grades/learning view in the app; health strip link to out/runs warnings; optional `rh_client.py` for a fully deterministic export.

## (old) Step 2 plan
1. Inventory each scorecard: inputs, weights, coverage, where it's persisted (Cursor is adding `fund_score_snapshots`; see A14).
2. STREET scenarios on the 265-name universe: (a) base pillar, (b) reward/penalty layer (user's hypothesis), (c) excluded. Show rank shifts, verdict changes, top/bottom movers, and which recs flip. Then Step 3 history pull → test which version actually predicts outcomes.
3. Re-run in market hours: `research/lseg/sync_signals.py` → `fit_model.py` → `build_plan.py` → `verify_plan.py` (live) → `publish_model_list.py`, so the provisional items resolve.

## Coordination
- Uncommitted mixed work on `cursor/mac-dev` (97+ files). Agree on commit discipline with the user before committing.
- Cursor owns scores/scanner/UI; this session's shared-file edits are listed in A13.
