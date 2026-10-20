# TradeDash — state archive (Claude)

> Finished sections moved out of `state.md` verbatim on 2026-10-11 (token trim). Append-only; read only when you need the history.

## Done 2026-10-06 (from Next tasks)
Done 2026-10-06 — fund-1.1.1 champion in scorecard_params (user YES; 1.1.0 retired with its real optionalMetrics). Hooks: Read guard only; rehydrate dropped (2 s/prompt, stale). Verified: tsc 0 errors both apps, api 235/235 + web 334/334 tests, vite build OK, validate-workflow 9/10):
- Backlog already closed: options-income chart, finnhub coverage, backfills, crash handlers.
- Nightly log filename dated per write. Vitest-only tests → node:test. `npm test` fixed for Node 26 (api: `tsx --test`; web: dropped `--experimental-transform-types`).
- orval codegen fixed: js-yaml override `>=4.3.0` resolved to 5.x (no default export) → `^4.3.0`. Output identical to committed.
- Macro card threshold tests: `macro/macro-implications.test.ts` (14) + `macro-policy-signals.test.ts` (8; logic moved to `macro-policy-signals.ts`). Found + fixed: event today read as "tomorrow".
- Stock DB redesign was already done; fixed stale legend swatch.
- All 39 pre-existing tsc errors fixed (incl. real bugs: Finnhub dividendYield provenance note overwritten by duplicate key; scheduled-tasks duplicate research-ops import; stale option-scoring dist).
- Line ratchet: every file back under its ceiling via splits (no behavior change) + dead-code removal (legacy fund scorer in fundamentals-db, unused imports). Ratchet count now matches wc -l.

## Recommendation-quality review (2026-10-06) — all 5 fixes DONE (user approved "all ok"); ASKS A37
Original findings:
- Options-scanner tilt is already live from ONE expiry week (model_recs graded = 55, all expiry 2026-10-02; TILT_MIN_N=20 counts recs, not expiries) → call income weight ≈ +20%.
- Backtests use today's 259-name universe (survivorship bias, not handled anywhere) and 0.85 fill vs RH-observed 16–35% haircut.
- Live hotlist (RSI/MFI/stoch dip/rally) and scanner v4 tech total = factor families the lab found no edge in; Model List alone is evidence-based.
- RH realized: puts +$16.6k (529, 85.6% WR), calls +$1.4k (322); but $141k stock bought via assignment, and portfolio_positions has no cost basis (avg_cost/cost_basis = 0) → no wheel-level P&L anywhere.
- trader-context.md thesis (oversold + high IV) conflicts with lab/Step 8 (oversold no edge; drawdown needs uptrend + analyst support; idio vol hurts after assignment).

Shipped: tilt ≥8 expiries · cost carry-forward (ingest + collector) · wheel.py → Model List why-line (run #18) + grade_rh_trades wheel_losers ·
model_avoid chip (Live + scanner) + 'unvalidated' labels · trader-context.md rewrite · survivorship.py (bias ≈0, high-vol small caps +0.1 pt/mo).
Not done: DB backfill of snapshot 13 avg cost (auto-mode denied; next export ingest fixes). Not browser-verified. tsc 0 both; api 245/245, web 334/334.

## RH strategy review (2026-10-06, after rec review)
- Accounts: IRA `772445425` = the strategy (judge the model here); FILDI `5QU47796` = mixed (crypto, prediction mkts) → needs rebalance recs.
- `analysis/timing_rh_trades.py` (out/timing/report.md): user's dip/support put timing and post-rally call timing beat same-OTM random days
  (put breach 17% vs 26% no-dip; calls after rally 7% vs 23%), same sign both halves of 2026, P&L diff not yet significant (CI crosses 0).
  Conflicts with trader-context "oversold = no edge" (that was universe-wide RSI); proposed to user as a tracked signal, not applied.
- `analysis/block_audit.py` (wired into daily.py publish stage): grades every L2-verified contract at expiry by block reason. First rows 10/09.
- Verify facts: Fildi premium = Schwab/Yahoo **bid** (not mid); RH realistic fill = bid + 10–36% of spread (median ~23%).
  Spread blocks were mostly after-hours quotes (plan 2, 10/02 close); in session (plan 3) spreads tightened.
- User YES (all 4) → shipped 2026-10-06, uncommitted: spread rule (rules.py/verify_plan.py; blocks 12→3 on the 29 past checks) ·
  Schwab re-price at verify (`lib/schwab-option-quotes.ts` + `POST /api/schwab/option-quotes`, localhost; 13/13 tested) ·
  `option_chain_history` from the nightly option-score chains (`lib/option-chain-history.ts`, 0 extra calls; first rows next nightly run) ·
  setup tag (`setup.py`) · margin rule (`params portfolio.no_new_puts_on_margin`) + FILDI rebalance folder (`rebalance.py`, folder row in DB) ·
  Model List run #19 published. tsc 0; api 248/248.
- Research library: `research/studies/` (INDEX catalog S001–S013, METHODS, README, cards S011/S012); `out/**/*.md` now versioned.
- Next: block audit first grades 10/09; re-run timing study after ≥ 100 new trades; exit-rule study once chain history ≥ 3 months.

## Daily reflection S014 (2026-10-07, uncommitted)
- User: only Cursor completes Muse tasks (CLAUDE.md startup already says skip Muse rows).
- `analysis/daily_reflection.py` (in daily.py publish stage) → `out/reflection/<date>.md` + `report.md` + cumulative `log.csv`.
  Today's prices via new localhost `POST /api/schwab/equity-prices` (routes/schwab.ts, shared 60s livePriceCache). tsc 0.
- Day 1 (10/07): IC raw +0.05 / IV-fixed +0.02 (no signal yet); 14 trader opens all off-Model-List, 10 no-dip puts (ONDS ×7, red fit);
  data gaps: prices_historical 10/06 bar missing for ~410/569 names; LQDA 9/30 snapshot spot 53.22 vs close 30.26.
- Stop rule in INDEX "Next studies": decide on option_score at ≥ 8 expiries / ≥ 100 ideas; a mistake kind on ≥ 5 days → own study.
- 10/09: reflections for 10/08 + 10/09 run manually (daily.py hasn't run since 10/05 → no Model List since run 19, no 10/07 snapshots,
  prices_historical ~305/569 names 10/06–10/08). Fixed log.csv date typing. 10/09 expiry: top-half score 81% won vs bottom 84% (361);
  put raw IC −0.2..−0.3 (high score = high IV), IV-fixed ≈ 0. found_wrong log re-counts the same contract each day (dedupe TODO).
- Price-gap root cause (10/09): no scheduled universe-wide daily-bar job; prices_historical only refreshes on server startup (cap 25),
  page views, or manual `backfill-stale-prices.ts` (STALE_DAYS=4 misses 1–3 day gaps). Yahoo path works without LSEG. Backfilled
  566 names → 568/570 bars 10/06–10/09. Schwab /pricehistory not implemented. User YES 2026-10-11 → DONE (uncommitted): `getSchwabDailyBars`
  (schwab-client.ts) first in `fetchAndStoreOHLCV` (Schwab → Yahoo only if Schwab thin/stale → LSEG soft fill; `mergeSchwabYahoo`);
  `lastCompletedSessionYmd`/`isTradingDayYmd` (market-hours.ts); backfill-stale-prices.ts selects active names missing the last
  session, no cap in maintain.mjs, exit 2 when coverage < 95%; `lib/price-coverage.ts` + `prices-coverage` ops alert
  (scheduled-tasks-inventory.ts, wired in routes/scheduled-tasks.ts); tech snapshot asOf = last session. Tests 257/257, tsc 0.
  Sunday live test: 568/570 fresh for 10/09 (EQR delisted, WBD halted since 10/05); deleted+refilled AAPL/NVDA 10/09 → source schwab,
  identical OHLC. Weekend tech_score_snapshots dupes (10/10 + 10/11, 1,140 rows) deleted with user OK 2026-10-11 (backup in session scratchpad).
  Committed + pushed by Cursor in a68c3d1 (checkpoint incl. Claude's work, 2026-10-11). Told Cursor via ASKS A58 (impacts + Muse overlaps).
  Option snapshots keep calendar asOf on purpose (live chain quotes; re-dating would overwrite Friday). Bug: tech_score_snapshots asOf uses UTC date (wrote 2026-10-10 at 22:45 PT).

  (2026-10-11: the UTC-asOf bug above is fixed — tech snapshot asOf = lastCompletedSessionYmd.)

## Fundamentals pipeline state (2026-07-23)
- Universe: ticker_registry WHERE fetch_fundamentals=true (335 tickers after removing SKHYV+ADYEN)
- Gold coverage: ~92.8% (335 active tickers × VALID_FIELD_DEFS). Was 77.6% pre-session — the
  regression was the subprocess-spawn bug (below), not real data loss.
- Only 2 flagged tickers now lack a ticker_fundamentals row (down from 61): both are peer-expansion
  edge cases; the 59 recovered were blue-chips (GS/MA/BAC/ASML/KLAC…) whose fetched staging data
  was never being merged.

### This session's changes (all in merge-trusted.ts / nightly-enrichment.ts / populate-source-fundamentals.ts)
1. **Subprocess bug FIXED**: nightly-enrichment ran populate+merge as `npx tsx` subprocesses via
   execFileSync and swallowed failures as WARN — silently failing in the long-lived prod server.
   Now runs them in-process (`runPopulateSourceFundamentals()`, `runMergeTrusted()` exported;
   process.exit only in CLI guards). A failure marks enrichment_runs `partial`.
2. **EDGAR → last-resort** in every FIELD_DEFS chain (was winning totalStockholdersEquity /
   interestExpense despite being annual/lagging).
3. **Divergence redesign** (isMaterialDivergence): winner-vs-fallback, period-aware, materiality
   tolerances → "Needs Review" 2208 → ~1017. Reads GET /fundamentals/divergent.
4. **Definitional alignment**: cashAndEquivalents = yahoo totalCash only (cash+STI concept);
   totalDebt = yahoo→fmp only; revenueGrowthYoY/epsGrowth on annual basis. NOTE: revenueGrowthYoY
   VALUES shifted (quarterly→annual, e.g. AAPL 16.6%→6.4%) and affect the growth score.
5. Removed SKHYV (pre-IPO→SKHY) + ADYEN (foreign) from registry + all fundamentals tables.
6. finnhub debtToEquity parser fix + override_flags column plumbing (from prior session, still uncommitted).

### Still open / next
- **Rebuild+restart to deploy** (deferred by user) — see Active work note.
- Residual ~1017 Needs Review is genuine vendor disagreement (lease inclusion, price-snapshot
  timing, growth basis) — driving lower needs looser tolerances or per-field comparable curation.
- Backfill safe order: check api_usage budget → backfill-fmp → backfill-polygon → (populate+merge
  now automatic via nightly-enrichment) → backfill-av.

## Original long forms (condensed in state.md on 2026-10-11)
## FactSet Proxy — LIVE ✅
- Oracle Cloud VM `146.235.223.94` — Ubuntu 22.04, VM.Standard.E2.1.Micro (Oracle Always Free)
- SSH: `ssh -i ~/Desktop/ssh-key-2026-06-14.key ubuntu@146.235.223.94` (key on Mac Desktop only)
- PM2: `pm2 logs factset-proxy --lines 30 --nostream`
- FactSet account: `USCMARSHALL-2393811` — Overview Report Builder API only
- Endpoint: `GET /report/overview/v1/financial-highlights?id=TICKER-US`
- Fields: Revenue, EBITDA, EBIT, Net Income, EPS, margins, ROE, ROA, FCF, Current Ratio, D/E, Total Equity, Cash, OCF, Revenue Growth YoY, EPS Growth
- Fields NOT from FactSet: PE, P/B, P/S, ROIC, Beta, WACC, Analyst Target, Interest Expense, Total Debt, Shares → FMP fills these
- Cache: DB-first, 7-day freshness. Only `POST /api/sdm/refresh/:ticker?admin=true` forces live call.
- IP `146.235.223.94` is **Reserved** in OCI ✅

## Watchlist recommendations (Claude, 2026-10-05)
Live: app Watchlist → **Model List** tab (champion `fit-1.4.1` from `watchlist_sync.model_params`; portfolio-sized ideas, Needs Review, Manage Open Positions).
Updated daily by the Robinhood export session (COLLECT_PROTOCOL Steps 13–14 → `scripts/watchlist_sync/daily.py`). Learning loop `learn.py` (bounded auto-promotion).
Health strip in the Model List header shows pipeline freshness. Next: first live grades 2026-10-09/12; Cursor A17–A21 (IBES coverage batches, AVB deactivation). Details: `scripts/watchlist_sync/NEXT_SESSION.md`.

## Archived from state.md 2026-10-20 (scripts/state_rotate.py, verbatim)
- **10-18 night DONE:** A170 (S046 → options-1.2.0 calls live), A171 (scoreboard: Own−Avoid vol-matched +5.3 pp wk1; IRA +62 bp vs SPY/QQQ +3 bp per trade, return/risk 0.88 vs 0.06 — 6/396 trades app-era), A174 (Avoid-holdings alert: GOSS MP ONDS OPEN), PLAYBOOK.md for all agents. Open: A172 shadow mode (Cursor). Next session = Jamie trading-strategy analysis. Old summary: (1) S046 call-side + Avoid-list re-test on their own outcomes (covered-call pnl; Avoid = left tail / 2σ drop) with s045 harness. (2) Weekly scoreboard job (Own−Avoid vol-matched, FV quintile spread, put Brier vs market-IV, IRA put pnl vs naive SPY/QQQ 1σ puts) → Portfolio Alerts card. (3) Shadow mode: store options-1.0.0 score beside 1.1.0 per snapshot, grade both at ≥ 8 expiries. (4) Gate new ASKS rows: must name which scoreboard number they move. (5) Holding-on-Avoid line in Portfolio Alerts. Done 10-18 late: 12 expired picks graded early; transcripts Haiku-timeout crash fixed.
- **10-18 late (Claude):** A167 built: options-1.1.0 (put tech = trend − volumeConfirm, quantile-matched; nodeGap replaces support) behind champion; both pick paths share `put-scoring-inputs.ts`. options-1.1.0 PROMOTED 10-18 (rollback: promote_options_1_1_0.py --rollback). Grade vs 1.0.0 history at ≥ 8 expiries. Schwab re-authed 10-19 01:0xZ (167 h). Next if wanted: shadow mode for challengers (A167 design section).
- **10-18 night (Claude):** Jamie: "don't ship" studies tested the wrong thing → S045 re-test on put pnl/breach (79k puts, LSEG 2020→): tech score works for puts when reweighted (trend − volumeConfirm, +15.7 bp/wk OOS) → A167 needs Jamie yes; S/R node between strike/spot = worse; HAR/2σ/streak/SUE/IBES still null; regime sizing marginal. METHODS rule 1b. Schwab: watchdog LaunchAgent com.fildi.schwab-auth-watch (first prompt Mon 10-20 08:00 PT; token dies Tue 14:19 PT).
- **10-18 late (Claude):** S041 reclassified FAIL (mechanical). S044 week-ROI review written (`research/studies/S044-week-roi-review.md`): scoreboard = Own−Avoid vol-matched, FV quintile spread, put Brier, IRA P&L vs naive SPY/QQQ puts. Rec: slow builds ~4 wks. Waiting Jamie: reaction to S044 + 5 holdings on Avoid.
- **NEXT SESSION FIRST (Claude 10-18 final):** (1) Review Cursor: A114 re-date fix, A155 single code path, A161 Kupiec backtest, A159 S041 result, A162/A163. (2) P16v2 0.823 → score on new needs-jamie/ASKS items (true hold-out); P14v2. (3) LSEG now logged in → optional TRBC second check (GICS via WRDS already live). Done 10-18: S033 FAIL (HAR +0.015 IV-fixed < 0.02 → A137/A138 declined), A161 scenario BS repricing, seed:peers override bug fixed (44 restored), A117 ρ floor, WRDS GICS monthly check + 4 moves, A120 closed, S042/S042b, A148/A154/A24/A74 done. Tree clean of Claude files.
- **OpenJev use cases (10-17, S037):** copied Lopez-Lira 2023 + awesome-jev uses (gate/labeler/judge). 3,913 Finnhub headlines, 90 tickers: reads direction (IC +0.10/+0.15 relevant) ≈ keywords where they fire, +0.05…+0.09 where silent (72 %); next-day IC ≈ 0 (no trading use, 2nd fail); materiality ≈ news count; headline-action extraction 96 %. Filed A142 (analyst_events 35 % roundup links, bug) + A143 (desk overnight labels, planned). Next untested angles: 2σ-drop cause tags (hand-label 30 days), Laya/Verdict small models vs 26B on S037 set (speed/RAM), image questions (screenshots), think/samples variants only if a use needs more accuracy. J5: proposed owner-tag routing (Muse answers first), awaiting Jamie 'go'.
- **OpenJev control layer (10-17, S038):** peers 82 % vs 68 % rules (→ A148 needs Jamie: proposed moves + monthly audit); vendor-conflict causes fail; entity macro views ~60 % precision (pre-filter); FV placebo: copies whatever target is shown → never use for FV/weights. Bugs → A147 (19 double peer memberships incl. all overrides; Yahoo 0 dividend yield for NEE DUK D AEP). Regime (b/d) + task monitor (g): answered as design, no OpenJev test.
- **OpenJev levers (10-17, S039):** calibrate every shown probability (Platt on our labels); peer prompt v2 (+financials +examples) for A148; scenario panel A149; chart lows/highs = no edge (signal absent). Next: fine-tune Laya/Verdict on our labels (torch install, Claude-labelled ~500 items ≈ $1), commit-quant gate + ASKS dedupe/routing + needs-jamie info-only gate (untested ops uses). Orphan-server gotcha: `pkill -f 'python -m openjev'` misses 'Python -m openjev' → kill by port 8091 owner.
- **OpenJev framework (A150, 10-17/18):** `.agents/openjev/` README + registry (numbers only via `oj.py eval/analyze`, 2nd-agent verify, `oj.py check` in validate-workflow, live audit). Commands in daily use: files (P10 B 0.956), run (P11 0.987 LB 0.961 → A after verify), studies/dupes = keyword rank (P14 X), skill, analyze (P21 0.60). AI tab: caller → OpenJev beams (restarted API 10-18). Waiting: Cursor/Muse verify P10/P11/P21. Next: P16 needs-Jamie gate eval, P12 quant-diff gate once ≥ 50 labelled commits, prompt v2 for P10. J5 → A153 (any-agent NEEDS YOU replies).
- **10-16 later:** git auto-merge (mergiraf/union/rerere) + `scripts/agent-git-sync.sh` = only way to sync (AGENTS rule 2). Caveman style = AGENTS rule 9. Shipped: A121 verified, A135, A134 dealer-gamma line (fcf1f35), A128 route-map/commit-impact scripts (f10f988), A130 all Haiku calls logged + AI spend line (bd69f32), forecast ledger (51e9cc9; first resolved 10-17, ≥20 after 10-23) → then OpenJev pilot (A129, 48 GB Mac fits). A123 declined. Waiting Jamie: A122 Muse app file access.
- **10-16 Instagram-batch review DONE:** 24 Muse rows A115–A139 plan-reviewed (ranked list in chat; files carry details). Dependency fixes found: SqueezeMetrics free SPX GEX 2011→ (A134), Polygon free 1-min bars ~2 y (A126/A139/A120 T1), HAR history already in lseg daily_history (A137). Claude next: run **S033** (HAR/TimesFM vs RV20 → options score; biggest PM lever) then **S034** (GEX), S035/S036 later — all pre-registered in studies INDEX. Check SPY/QQQ rows land in option_chain_history after 10-16 12:45 PT run (9a14837 added them; none yet). A121 fix sits uncommitted in Cursor's tree.
- **Studies 10-15 (S017–S028):** S017 hold stays (no 2× stop/close-ITM) · S018 earnings IV overpriced 0.65×, not persistent · S019 IV-rank gate fail (Polygon closes ~3 % above mid) · S020 keep plain CSPs · S021 S003 premiums ~25 % cheap, no decision reversed · S024 sector weights fail · S025 no bounce edge except SPY<200d 27 % vs 17 % · S026 no calendar/event effect · S027 no regime effect · S028 wide credit spreads warn of S&P drawdowns (display-only). Next: A120 track 5; credit_wide line in Portfolio Alerts if Jamie wants.
0. **PM agent (user 2026-10-14: Claude = PM, Cursor = dev, Muse = ideation).** S015 (08b8ce6): picks fine, assignment EV-neutral, breaches cluster. Built: `pm_book.py` (--live Schwab) + `pm_alerts.py` (probabilistic: market-IV P(assign), calibrated on 926 puts 18% pred vs 21% real n.s.; one-factor ρ=0.6 fits S015 clustering; 20k-path P(margin call); thresholds 10%/30% defaults) → table `watchlist_sync.pm_alerts` → `GET /api/pm/alerts` → **Live › Portfolio Alerts** tab. LaunchAgent `com.fildi.pm-alerts` (15 min mkt hours, 2 h otherwise). **No push/email** (user deleted email bridge 10-14; no crazy alerts). User decisions 10-14: crash budget 25% red / 20% amber; Claude plan-reviews every Muse row. Declined A47/A51/A57; A74 narrowed; A75 v2 (all sources probed: RH Trading MCP reads all accounts = live book, Schwab expirationchain = Model List unblock, Polygon free option EOD bars, FMP symbol-restricted, Polygon financials GONE); A72 v2 (G1: Mac mini vs Oracle). Pending user: A72 G1. (RH MCP set up — user 10-15.) A76 left for Cursor: Book card + Expiry what-if. **10-14 later:** Model List re-prices Friday picks daily from option_chain_history, rolling when < 2 DTE (b99a17d; puts L1 0 → 14, user approved). transcripts.py (AV ≤ 20/day, Haiku summaries; LaunchAgent com.fildi.transcripts 05:30) + Your names (SI from LSEG short_pct, earnings, call summary) in Portfolio Alerts. Endpoint matrix: .agents/context/data-source-fields/endpoint-entitlements.md. A72 v3 = Oracle free + laptop pushes LSEG/RH (no hardware). A84 bugs → Cursor. Breakdown panels: Short interest (Polygon FINRA history + LSEG % float; `short_interest_history`) and Earnings call (transcripts schema v2: guidance items vs prior vs Street, model inputs, KPIs, tone script/Q&A + trend, analyst pushback; book names back-fill 3 prior quarters). Oracle tenancy already exists (FactSet proxy micro VM); user waits on A72. **Fair value trail (10-14):** Breakdown › Assumptions (shared rules fv-1.0.0 + cohort = peer group + inputs w/ last-changed/history + judgement ledger `fv_assumptions`, adjusted FV separate) and › Earnings calls (all quarters + guidance across calls). Found 25 profitable large caps (ADBE, IBM, CRM, INTU…) with NO fair value because their cohort mode is pre_revenue_ok/speculative_ok; fix `profitableUseStandard` (all no-method modes) **approved by user 10-14**; before/after 436→464 valued, 0 changed. **Promoted 10-14** (fv-1.1.0 champion, fv-1.0.0 retired; 464/568 valued). DB (local Postgres.app, no size cap; 1.5 TB disk free): 886 MB =  ~590 MB research lab tables (lab_tech/outcomes/fund, research-only) + ~170 MB LSEG/WRDS; app queries 1–170 ms; at A72 migration exclude lab_* from the server dump. Ongoing growth ≈ 3 MB/day (~1 GB/yr: chain history ~1.2, fair value ~0.4, transcripts ≤0.8, LSEG/prices/news rest). **Option history (user 10-14 approved S017 exit rules, S018 earnings, S019 true IV rank, S020 spreads/strangles/straddles, cheap extras):** pre-registered `research/studies/S017-S021-option-history.md`; loader `analysis/option_history.py` running detached (~35 h, resumable: rerun same command; log /tmp/fildi-logs/option-history.log) → schema `optlab`. Next: run studies when trades+earnings stages finish; A96 extras → Cursor. Holistic review 10-14 done (0dc1d3a, ce35e0c). **UI (73703e2):** Breakdown › Options history (earnings moves, IV, your puts + click path), Portfolio Alerts › Playbook (optlab.findings), Settings › Research (INDEX). User rule: method in ⓘ tooltips, point first. ⚠ Loader pid started before derive hook → after it finishes run `.venv/bin/python analysis/option_derive.py` manually. **10-16:** S029 recession odds FAIL (no skill post-2005) · S030 streaks FAIL · S031 intraday-grind drops recover 30% vs 21% (PASS, 14-mo sample, display-only, rerun Jul 2027) · S032 post-earnings drift FAIL. Shipped: Agents Stage (live hooks, subagents, jobs, links, NEEDS YOU threads via .agents/needs-jamie.md + needs_comments, hooks in settings.local.json), Portfolio open puts · odds (+S025 downtrend line), Portfolio Alerts wide-credit line (S028). Oracle parked (A72). Waiting on Jamie: J4 drill-down order, J5 auto-reply, J6 cloud snapshot, J7 Tailscale phone. Next Claude: A120 pattern-search engine (budgeted) or A115–A119 reviews. **10-15 late:** S017 done (hold stays; 2× stop −$13.7k, close-ITM −$12.5k), S018 done (overpriced 0.65×, not persistent → A79 facts only). A84 decided (polygon last-resort). Agents tab v2 + hook event log (~/.fildi/agent-events.jsonl via .agents/hooks/agent-event.mjs; Claude hooks in settings.local.json, Cursor in .cursor/hooks.json). Cursor gating: one planned row at a time. Inbox research/inbox.md. Oracle: user agreed hybrid (Mac master; Oracle = public-data jobs + read-only replica; never RH/LSEG/WRDS) — waiting on user VM + Tailscale. Next Claude: S019 → S020/S021 → S024 → A120 one track at a time. **10-15:** trades stage done (551); loader crashed on a connection reset at earnings 250/384 → retry fixed, restarted (caffeinate). Muse A97–A109 plan-reviewed, A110–A112 fixed by Claude; Claude rows renumbered A113 (holdings errors) / A114 (earnings dates) after an ID collision — **pull before filing ASKS**. Decline check in AGENTS.md. Claude next: S017/S020/S021 replay (`analysis/opt_replay.py`), S023 laggard study, "max book at bad-week breach rate" number in Portfolio Alerts (A105 note).
3. **Model List automation (ed25aae, 2026-10-11)** — maintain 07:00 runs `daily.py --if-needed`; verify on Schwab when no RH quotes; `intraday.py` after each regime checkpoint (≥2σ move / ≥50% cushion / SPY pause flip → re-verify + republish). LSEG works (probe 10/11 OK; synced 271 names). PENDING: user Schwab re-auth (`node --env-file=.env.local scripts/schwab-oauth.mjs`), API-server restart, then full verify+publish test on plan #7+ and first live intraday run Monday. **10/14 status:** automation runs (plans #8 10/12, #9 10/13 built; intraday fired 10/13–14 on POET/CAVA) but every verify exits 3 because Schwab is still logged out → Model List still shows run #19 (plan #3, 10/06). No plan built 10/14 yet: check maintain-last.json `modelList`. Fix = user Schwab re-auth, then `daily.py --from verify` on the latest plan. **10/14 PM:** Schwab re-authed (obtainedAt 2026-10-14T21:19Z, valid to ~10/21). Root cause of the "re-auth didn't take": `lib/schwab-auth.ts` cached tokens in memory and failed refreshes wrote the stale copy back over new tokens → fixed (mtime re-read + `saveError` skips when disk refresh_token changed); `schwab-oauth.mjs` now exits after save. Both uncommitted. NEW BLOCKER: plan #10 has 0 options: `fresh_snapshot` gate (rules.py MAX_SNAPSHOT_AGE_TRADING_DAYS=1) vs model_recs written only Fri (model-snapshot job) → Wed–Fri plans never have options. Needs user decision (daily snapshot vs gate). Before/after 10/14 (scratch, not built): daily snapshots double-count the track record; `option_score_snapshots` (daily ~12:45 PT, same pickBestStrike+tilt) fixes freshness but on Wed/Thu picks this-week expiry (204/249 at 1 DTE) → dte_band blocks; only 8 puts pass (2 inside the model_recs universe), 0 calls. Real fix = target-expiry chain scan (next-week expiry) for Wed–Fri builds, same as Phase 2 per-ticker scan. Also 35/46 Friday puts fail spot_drift by Wed. Phase 2 (not built): new per-ticker recs after big moves (S011 dip-timing evidence) needs a per-ticker chain scan.
