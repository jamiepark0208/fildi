# Model Accountability / Track Record — continuation (written 2026-07-30)

Full plan: `~/.local/bin/claude/plans/warm-pondering-thompson.md` (read it first if it still exists; this doc is self-sufficient otherwise).

## Goal
Hold the model accountable for its three judgment surfaces — (a) best sell-put/sell-call per watchlist ticker, (b) Live-tab hotlist GO/WATCH dip/rally calls, (c) business-cycle regime calls — by snapshotting weekly, grading against realized prices, feeding a bounded auto-tilt back into the scorer, and proving the record with visuals. Universe = distinct union of user watchlists only.

## DONE (Phases 1–5, all typechecked + api-server esbuild passes)

**Phase 1 — shared package `lib/option-scoring/` (`@workspace/option-scoring`)**
- Moved verbatim from stock-compare: `option-scorer.ts`, `option-scorer-constants.ts`, `technical-rankings.ts`; added `tilt.ts` (tiltFactor/applyTilt, TILT_MIN_N=8, anchor winRate 0.70, ±25% shift on income/buffer only), `index.ts` re-exports all.
- Old stock-compare paths are one-line re-export shims → no client import changed.
- Deps added to both artifacts' package.json; tsconfig references added (root, api-server, stock-compare). NOTE: `pnpm run typecheck:libs` (tsc --build) must run before artifact typechecks — libs emit declarations to dist/.

**Phase 2 — schema** (`lib/db/src/schema/index.ts`, end of file): `model_recs`, `hotlist_snapshots`, `regime_grades` (denormalized, no FK — market_regime prunes at 90 rows before 12w horizon). Tables ALREADY CREATED in DB via direct psql DDL (drizzle push prompts interactively and hangs headless — don't retry push for these; DDL matches schema exactly so push sees no diff).

**Phase 3 — snapshot job** `artifacts/api-server/src/lib/model-track-record.ts`:
- `runModelSnapshot()`: union watchlist tickers → technicals rows + default-weight `computeTechnicalRankingsV2` per side + persisted fund scores → `getOptionsChain` at concurrency 3 → shared `pickBestStrike` with tilt-adjusted default weights → insert model_recs (onConflictDoNothing) + hotlist GO/WATCH rows + regime stubs.
- Scheduler (`lib/scheduler.ts`): Friday 19:00 UTC window (market open → live bids), key `last_model_snapshot_run`, 8-day catchup, exports `lastModelSnapshotRun`/`modelSnapshotRunning`, wired into 30-min heartbeat + startScheduler hydration.
- `routes/macro-regime.ts`: extracted `getMacroRegimeResult()` (route now calls it; snapshot job reuses cache).

**Phase 4 — grading + tilt** (same module): `runModelGrading()` called inside `runTradeExpiry()` after `resolveExpiredOptionTrades()` (each stage own catch). `closeOnOrBeforeExpiry` now exported from `trade-post-expiry.ts`. Settlement: intrinsic put max(K−C,0)/call max(C−K,0), pnlPerShare=premium−intrinsic, WIN iff >0, pnlPct basis strike(put)/spot(call); NO_DATA after 14d grace; split guard |close/spot−1|>0.6. Hotlist: 5th trading close after snapshotDate, dip WIN iff fwd>0, rally iff <0. Regime: horizons 7/28/84d, dead bands 1/2/4%, neutral drawdown credit −3/−6/−10%, `gradeRegimeCall()` pure+exported. `recomputeTilt()` → app_config key `model_tilt` (trailing 84d per side).

**Phase 5 — routes** `artifacts/api-server/src/routes/track-record.ts`:
- GET `/track-record/summary` (per-side scorecard + equity curve + hotlist aggregates, TTLCache "track-record" 10min, registered in cache-registry), `/recs?side&status&limit`, `/regime` (grid), `/tilt` (state + effective weights + minN/anchor).
- POST `/track-record/run` (requireAdmin) body `{snapshot?, grade?, seedFixture?}` — seedFixtures() inserts back-dated (21d ago, expiry 7d ago) synthetic recs/hotlist rows for tickers with price history, so grading is verifiable today.
- Mounted in routes/index.ts; "/track-record" added to the path-scoped requireAuth gate list. scheduled-tasks.ts payload extended.

## REMAINING

**Phase 6 — UI (stock-compare)** — was just starting; App.tsx routes read, pages lazy-loaded via `const X = lazy(...)` + `<Route path><RouteBoundary>` pattern (App.tsx:87-130).
1. Client tilt application: in `hooks/use-top-options.ts` (and options-scanner.tsx which passes `weights.optionStrike`), fetch GET /track-record/tilt (react-query key `["track-record","tilt"]`, staleTime 10min) and apply `applyTilt` from `@workspace/option-scoring` to DEFAULT strike weights only — if the user has explicit overrides in ScoringPreferencesContext (`weights.optionStrike`), user weights win. MUST check ScoringPreferencesContext.tsx to see how defaults vs overrides are represented (was about to read it — grep `optionStrike|DEFAULT`). options-scanner puts side currently passes `weights.optionStrike`; call side passes CALL_STRIKE_WEIGHTS (tilt call side applies there).
2. `pages/track-record.tsx`: scorecard cards (puts/calls/hotlist/regime), recharts AreaChart cumulative equity curve (pattern: `components/macro/macro-history-charts.tsx`), regime×horizon colored grid from /track-record/regime, recent recs table (/track-record/recs), tilt explainer panel ("+X% income emphasis — put win rate Y over n=Z / 12wk"). Register route `/track-record` in App.tsx + nav entry (find TabBar/nav — see settings.tsx TabBar; NO explicit JSX generics — Replit vite plugin crashes).
3. `components/credibility-badge.tsx`: pill "puts 68% win · 12wk · n=24" from shared `["track-record","summary"]` query; suppress win% below n=5 (show n only); copy notes "model default settings". Render in options-scanner side headers, live.tsx top-options section, rankings.tsx.
4. Regime accuracy strip (1w/4w/12w chips) on macro.tsx from `["track-record","regime"]`.

**Phase 7 — verify**
- Unit tests (api-server has `node --test`? verify convention; settleRec, gradeRegimeCall, maxDrawdownPct, tiltFactor/applyTilt are all exported pure fns).
- `pnpm run typecheck` (root: libs then artifacts), `pnpm --filter @workspace/stock-compare run typecheck`, api-server build.
- Restart per `.claude/skills/build-and-run.md`, then as admin: POST /api/track-record/run {seedFixture:true} → {grade:true} → GET summary/regime shows graded fixtures; {snapshot:true} on a market day → rows parity with scanner.
- Optional cleanup after test: DELETE FROM model_recs WHERE macro_regime='fixture'.

## Gotchas discovered
- drizzle-kit push is interactive even with --force (create-vs-rename prompt) — hangs headless; use psql DDL matching schema.
- `pickBestStrike` returns generic-constraint Opt; cast `best.put as OptionRow` for lastPrice/bidIsLive (server did this in model-track-record.ts:~166).
- python3 not available in shell; use node or sed for scripted edits.
- Uncommitted plan file lives outside repo; this doc is the in-repo source of truth.
