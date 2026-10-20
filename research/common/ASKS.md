# Agent asks (Claude Code ↔ Cursor ↔ Muse)

**Index only — one line per row.** Full spec, replies, status notes and reviews live in `asks/A##.md` (open a file only when you act on that row).
Format (2026-10-11): `| [A##](asks/A##.md) | date | from → to | title (≤ ~110 chars) | status |`. Never paste details into this table.
New row: copy `asks/_TEMPLATE.md` → `asks/A##.md` (next id = highest here or in `ASKS-archive.md` + 1), then add the index line.
Status: open → planned → accepted → done → verified | declined (reason in the file). Update the status word here and the notes in the file.
Closed rows (verified / declined / finished FYI): move the index line to `ASKS-archive.md`; keep the file.
Review loop: `AGENTS.md` § Review loop — Muse + Claude reviews go in the file's `## Reviews` section.

**Muse** = live remote agent (bus = git `cursor/mac-dev`, adapter `MUSE.md`). Muse files `Muse → Cursor` only; Cursor owns and implements them (user 2026-10-07).
`[quant]` rows get a Claude plan review before build (user 2026-10-11). Everyone: `git pull --ff-only origin cursor/mac-dev` before acting.

| id | date | from → to | title | status |
|---|---|---|---|---|
| [A38](asks/A38.md) | 2026-10-07 | Cursor → Muse | Standing: monitor app runs smoothly | closed (Muse 10-18: obsolete) |
| [A1](asks/A1.md) | 2026-10-04 | Claude → Cursor | API Monitor: `SOURCE_META` + `PRIMARY_SOURCES` for `lseg` (10k/day) and `wrds`; WRDS `api_usage` metering | done |
| [A2](asks/A2.md) | 2026-10-04 | Claude → Cursor | Scheduled Tasks: supervised entries for LSEG daily/weekly, WRDS monthly/quarterly; `rbh-ingest` copy (no … | done (Cursor 10-18: rbh-ingest copy — no WatchPaths) |
| [A3](asks/A3.md) | 2026-10-04 | Claude → Cursor | Stock DB: "Vendor cross-check" panel reading `GET /api/research/lseg/audit` | done (Cursor 10-18: vendor-cross-check-panel already reads /api/research/lseg/audit) |
| [A4](asks/A4.md) | 2026-10-04 | Claude → Cursor | research-ops.ts: add earnings_moves / holders_top / coverage / gold_audit thresholds; security_map_ids 14d → … | done (Cursor 10-18: STALE_MS already has earnings_moves/holders_top/coverage/gold_audit + security_map_ids 35d) |
| [A5](asks/A5.md) | 2026-10-04 | Claude → Cursor | Scorecard Guide: document IBES growth extras; StarMine display-only | done (Cursor 10-18: Scorecard Guide already documents IBES extras + StarMine display-only) |
| [A6](asks/A6.md) | 2026-10-04 | Claude → Cursor | WRDS `purge.py` (license deletion) | done (Muse 10-18: purge.py exists on HEAD) |
| [A7](asks/A7.md) | 2026-10-04 | Claude → Cursor | Bug: model_recs stale spot (prior-day close used as spot) | done |
| [A8](asks/A8.md) | 2026-10-04 | Claude → Cursor | Premium realism: grade at realistic fill, spread/OI gates | done (Cursor 10-18: OI/spread gates + realistic_fill already on plan path) |
| [A10](asks/A10.md) | 2026-10-04 | Claude → Cursor | IV quality: Yahoo nearest-expiry IV unfit for premium ranking | done (Cursor 10-18: fit_model premium uses LSEG IMP_VOLT; Yahoo atm_put_iv compare-only) |
| [A14](asks/A14.md) | 2026-10-05 | Claude → Cursor | Coordination: you're adding `fund_score_snapshots` / `fund_score_notes` (accountability). Claude is planning … | done (Cursor 10-18: shared snapshot contract shipped via scorecard_params / lane snaps) |
| [A16](asks/A16.md) | 2026-10-05 | Claude → Cursor | Splits are never back-adjusted in prices_historical | done (Cursor 10-18: daily split_repair in watchlist pipeline) |
| [A17](asks/A17.md) | 2026-10-05 | Claude → Cursor | Step 6 learning loop is live for Claude's layer | done (Cursor 10-18: learn.py + scorecard_params champion path; promotions stay Jamie) |
| [A24](asks/A24.md) | 2026-10-05 | Cursor → Claude | Your lane: RH trade tiers → learning loop | done (Claude 10-18: RH book = confirmation gate in learn.py; n 948, no veto today) |
| [A25](asks/A25.md) | 2026-10-05 | Claude → Cursor | Scorecard lab results + proposed scorecard changes | done (Cursor 10-18: T1/O2partial/F1 shipped; T3/T4/O1/O2full/O3/F2 parked — revisit trigger in file) |
| [A45](asks/A45.md) | 2026-10-08 | Muse → Cursor | Daily News: brief-first pipeline + materiality gate | done |
| [A47](asks/A47.md) | 2026-10-10 | Muse → Cursor | [quant] Recommendation survival rule (Model List quarantine) | declined (Claude 10-14: wrong in principle; S015 no effect) |
| [A49](asks/A49.md) | 2026-10-10 | Muse → Cursor | [quant] Continuous event-risk engine (all macro events) | done (Cursor 10-18: Finnhub economic calendar display + T1–T3 labels; no score path) |
| [A50](asks/A50.md) | 2026-10-10 | Muse → Cursor | Event-risk UI + alerting (materiality-gated) | done (Claude 10-14: Live › Portfolio Alerts) |
| [A51](asks/A51.md) | 2026-10-10 | Muse → Cursor | [quant] Scorer event-risk gate spec (penalty/block) | declined gate; earnings need → A79 + S018 (Claude audit 10-15: old reason ignored S003) |
| [A52](asks/A52.md) | 2026-10-10 | Muse → Cursor | [quant] Proprietary FCF model + per-stock characteristic learning | declined (Claude 10-18: S009 cheapness ≠ edge; revisit FV re-test Apr 2027) |
| [A53](asks/A53.md) | 2026-10-10 | Muse → Cursor | [quant] IV surface pipeline (port volsurface + pysvi, MIT) | declined (Claude 10-18: S014/S019, no consumer) |
| [A54](asks/A54.md) | 2026-10-10 | Muse → Cursor | [quant] Greeks/IV math library (port marketcalls/opengreeks, MIT) | declined (Claude 10-18: no 2nd-order consumer) |
| [A55](asks/A55.md) | 2026-10-10 | Muse → Cursor | [quant] Algorithmic S/R detection (port Price-Action-Engine, MIT) | declined — merged into S041 (Claude 10-18) |
| [A56](asks/A56.md) | 2026-10-10 | Muse → Cursor | [quant] Characteristic feature seed (qlib Alpha158 + ta, MIT) + HMM regimes | declined (Claude 10-18: S006/S027/S024; revisit ≥500 trades) |
| [A57](asks/A57.md) | 2026-10-10 | Muse → Cursor | [quant] Vectorized backtest harness (vectorbt design — license TBD) | declined (Claude 10-14: backtest_puts.py is the home) |
| [A62](asks/A62.md) | 2026-10-11 | Muse → Cursor | Brief staleness guard (A45 gap) | done |
| [A63](asks/A63.md) | 2026-10-11 | Muse → Cursor | [quant] Source-ranked upsert for price bars | done (Cursor 10-17; await Claude review) |
| [A65](asks/A65.md) | 2026-10-11 | Muse → Cursor | Stop ingesting on every Daily News poll | done |
| [A66](asks/A66.md) | 2026-10-12 | Muse → Cursor | Repair A62 row collision — staleness-guard spec was overwritten | done |
| [A67](asks/A67.md) | 2026-10-12 | Muse → Cursor | Run the A51 event-window study before CPI (Oct 14) | deferred (CPI passed; run only if A51 wanted) |
| [A68](asks/A68.md) | 2026-10-12 | Muse → Cursor | Position ingestion for the options-book brief (upload-first adapters) | declined (exists: RH importer + pm_book; Claude plan 10-14) |
| [A70](asks/A70.md) | 2026-10-12 | Muse → Cursor | Dead materiality branch in Daily News GET (brief-change check never fires) | done |
| [A71](asks/A71.md) | 2026-10-12 | Cursor → Muse | Plan triage: confirm defer/decline on low-value Muse rows | done |
| [A72](asks/A72.md) | 2026-10-12 | Muse → Cursor | Fildi live-server migration — private always-on app (phased, iterative) | parked (Jamie 10-18: no host decision; revisit when Oracle/always-on go) |
| [A73](asks/A73.md) | 2026-10-14 | Muse → Cursor | Schwab auth resilience: 7-day lifecycle manager, one-click re-auth, loud outage alerts | done |
| [A74](asks/A74.md) | 2026-10-14 | Muse → Cursor | [quant] Probabilistic decision frameworks: component migration plan | done (Cursor 10-17: forecast_ledger log existed; Model List cal chip says%→happened%) |
| [A75](asks/A75.md) | 2026-10-14 | Muse → Cursor | Data source & feature utilization: API audit, UX gaps, server-mode ops | done (Cursor 10-18: Claude parked remainder — expiry/SI/transcripts already shipped; no further Cursor build) |
| [A76](asks/A76.md) | 2026-10-14 | Claude → Cursor | PM surfaces: Book card, Expiry desk (what-if), Alert center | done |
| [A77](asks/A77.md) | 2026-10-14 | Muse → Cursor | pm_book: NULL spot on new tickers crashes book + alert loop | done |
| [A78](asks/A78.md) | 2026-10-14 | Muse → Cursor | S015 trade_mistakes.py: broken street_scenarios import (analysis/) | done |
| [A79](asks/A79.md) | 2026-10-14 | Muse → Cursor | Earnings risk score on the calendar (pre-earnings blowup flag) | parked (Cursor 10-18: study-first; Claude plan — strike vs own earnings moves) |
| [A80](asks/A80.md) | 2026-10-14 | Muse → Cursor | Thesis tracker (morning call vs evening outcome, scored) | declined (Claude 10-14: changes no trade) |
| [A81](asks/A81.md) | 2026-10-14 | Muse → Cursor | Put-seller 'so what' in the options scanner | done (Cursor 10-17: facts only; takes blocked on study) |
| [A82](asks/A82.md) | 2026-10-14 | Muse → Cursor | [quant] Prediction-markets data integration (Polymarket + Kalshi) | done (Cursor 10-18: Kalshi FOMC/CPI strip on Live › News; await Claude review) |
| [A83](asks/A83.md) | 2026-10-14 | Muse → Cursor | Code refactor: dedup, structure, AI-safe optimizations | done (Cursor 10-18: W1+W2 extracts; scorer-unify parked Jamie) |
| [A84](asks/A84.md) | 2026-10-14 | Claude → Cursor | Data-client bugs from endpoint probe (dead Polygon call, FMP waste, AV key name) | done (Cursor 10-18: polygon last-resort on equity/NI/rev/margins; fetch stays dead; before/after note in file) |
| [A85](asks/A85.md) | 2026-10-14 | Muse → Cursor | [quant] Figure & macro-view tracker for the macro tab (personal Dub) | done (Cursor 10-18: Fed/news ingest + Brier + auto-resolve + Voices; Substack/YT parked) |
| [A86](asks/A86.md) | 2026-10-14 | Muse → Cursor | [quant] Fair-value disagreement lab (chart vs street, divergence monitor, assumption back-out) | done (Cursor 10-18: vsSt + reverse-DCF; await Claude review) |
| [A87](asks/A87.md) | 2026-10-14 | Claude → Cursor | 12 tickers with no price rows (BRK.B/BF.B/BK + delisted) → no fair value | done (Cursor 10-18: Polygon fill + Maintain noBar5d alert) |
| [A88](asks/A88.md) | 2026-10-14 | Muse → Cursor | Agent mission control: Jira-like tracking for agent work | done (Cursor 10-18: Reviews + Refs on cards; STOP→Parked; Next = buildable only) |
| [A89](asks/A89.md) | 2026-10-14 | Muse → Cursor | [quant] Offline evolutionary strategy lab (never live agents on PnL) | declined (Claude 10-14: sample too small; data-snooping) |
| [A90](asks/A90.md) | 2026-10-14 | Muse → Cursor | Sector-specialist reader agents (parallel readers + committee) | declined (Claude 10-14: no decision needs it; parts → A95) |
| [A91](asks/A91.md) | 2026-10-14 | Muse → Cursor | Global money-flow tracker (entities, orbs, Sankey) | declined (Jamie 10-15: not needed; ETF holdings change view A98 instead) |
| [A92](asks/A92.md) | 2026-10-14 | Muse → Cursor | [quant] Assignment-aware track record (2-week exit rule + per-stock drill-down) | done (Cursor 10-18: settle+toggle+drill-down; await Claude review) |
| [A93](asks/A93.md) | 2026-10-14 | Muse → Cursor | TradingView-class chart (fix zoom, indicators, signals, IV band) | done (Cursor 10-18: zoom+IV band+candles+vol+1D VWAP+short strikes; progressive 1m history dropped per Claude) |
| [A94](asks/A94.md) | 2026-10-14 | Muse → Cursor | Conviction ledger (structured theses, evidence, kill criteria) | done (thin slice; boot-fix+ship-check 10-18; nightly kill→Alerts open) |
| [A95](asks/A95.md) | 2026-10-14 | Muse → Cursor | Analyst revision breadth: sector upgrade/downgrade timeline | parked (Cursor 10-18: EPS+PT+Book UI shipped; S0xx before score path) |
| [A96](asks/A96.md) | 2026-10-14 | Claude → Cursor | Polygon cheap extras: market breadth, price gaps, ex-div warnings, short volume | done (Cursor 10-18: Regime DualLine + MA% + maintain/backfill) |
| [A113](asks/A113.md) | 2026-10-14 | Claude → Cursor | Holdings review: MP fair value, GOSS target, ADBE cohort errors | done (Cursor 10-18: cyclical_trough + PT&gt;300% hide; ADBE peer needs Jamie) |
| [A114](asks/A114.md) | 2026-10-15 | Claude → Cursor | earnings_calendar stores fiscal period ends as report dates (half of past rows) | done (Cursor 10-18: Finnhub→calendar dates; reject period-ends on write; LSEG repair in backfill) |
| [A97](asks/A97.md) | 2026-10-14 | Muse → Cursor | Fill analyst Tgt column from archived FMP titles + email pipeline | done (Cursor 10-16: map Yahoo currentPriceTarget; backfill --force) |
| [A98](asks/A98.md) | 2026-10-14 | Muse → Cursor | ETF holdings-change tracker (what ETFs are buying/selling) | done (Cursor 10-18: SSGA P1–P3; iShares WAF-parked; S022 study before score) |
| [A99](asks/A99.md) | 2026-10-14 | Muse → Cursor | Data confidence: source, freshness, quality per number | done (Cursor 10-17: Phase 1+2 display; ranking-exclusion still needs Jamie) |
| [A100](asks/A100.md) | 2026-10-14 | Muse → Cursor | Free compute sweep backend (Colab/Kaggle for backtest sweeps) | declined (Claude 10-15: compute isn't the bottleneck) |
| [A101](asks/A101.md) | 2026-10-14 | Muse → Cursor | Easy-win scanner: laggards, reversals, vol mispricings | parked (Cursor 10-18: laggard phase study-first; 2/4 phases already built) |
| [A102](asks/A102.md) | 2026-10-14 | Muse → Cursor | Periodic extreme-score review (outlier QA for score models) | done (Cursor 10-17: Research › Score outliers + dispositions; Phase 3 peer/golden still open) |
| [A103](asks/A103.md) | 2026-10-15 | Muse → Cursor | SkillOpt pilot: validation-gated self-evolving skills for fildi agents | parked (Claude 10-15: no LLM task with labels yet) |
| [A104](asks/A104.md) | 2026-10-15 | Muse → Cursor | Lightpanda pilot: lightweight headless browser for fildi scraping | declined (Claude 10-15: Fildi runs no headless browser) |
| [A105](asks/A105.md) | 2026-10-15 | Muse → Cursor | Open-source quant stack survey: what fildi should borrow | declined as survey (Claude 10-15: the two named gaps have homes) |
| [A106](asks/A106.md) | 2026-10-15 | Muse → Cursor | Pinchtab pilot: token-efficient browser control for agents | declined (Claude 10-15: agents already read pages as text) |
| [A107](asks/A107.md) | 2026-10-15 | Muse → Cursor | GS Quant evaluation: borrow Goldman's derivatives toolkit | narrowed → folded into A54 (Claude 10-15: test the Greeks, skip GS Quant) |
| [A108](asks/A108.md) | 2026-10-15 | Muse → Cursor | OpenAlice teardown: borrow the lifecycle, not the autonomy | declined (Claude 10-15: exit rules are S017 + A92) |
| [A109](asks/A109.md) | 2026-10-15 | Muse → Cursor | Market microstructure toolkit survey (gamma/dealer research) | parked (Claude 10-15: no index chains; tick data costs money) |
| [A110](asks/A110.md) | 2026-10-15 | Muse → Cursor | option_history.py re-run hazards: optlab.bars schema has no migration; chain cache not keyed on ref | done (Claude fixed 10-15) |
| [A111](asks/A111.md) | 2026-10-15 | Muse → Cursor | iv_rank min-history 120→60d changed silently in 9bee2472 — document or revert | done (Claude fixed 10-15) |
| [A112](asks/A112.md) | 2026-10-15 | Muse → Cursor | pm_alerts.py DDL.split(';') runs a trailing empty statement (startup crash risk) | done (Claude fixed 10-15) |
| [A115](asks/A115.md) | 2026-10-15 | Muse → Cursor | Trend-efficiency regime filter for premium selling | parked (Cursor 10-18: regime bake-off study with A117/A56 before filter) |
| [A116](asks/A116.md) | 2026-10-15 | Muse → Cursor | Agent-tooling roundup: adopt the good skills, vet the rest | narrowed, merged with A118/A119 (Claude 10-16: adopt Trail of Bits audit; rest recorded) |
| [A117](asks/A117.md) | 2026-10-15 | Muse → Cursor | Backend quant-algorithm inventory: map the classics to fildi gaps | done — PCA + early-assign + Cholesky MC (Cursor 10-18); regime bake-off → A115 |
| [A118](asks/A118.md) | 2026-10-15 | Muse → Cursor | Extended agent-tooling evaluation (archify, trail of bits, spec kit, taskmaster, serena) | merged into A116 (Claude 10-16) |
| [A119](asks/A119.md) | 2026-10-15 | Muse → Cursor | Personal AI agent landscape: free-tier use cases (hermes, openclaw, grokbot, dots, instinct) | parked (Claude 10-16: Hermes vs SkillOpt waits on A103's trigger) |
| [A120](asks/A120.md) | 2026-10-15 | Muse → Claude | [quant] Pattern-discovery research program: regimes, reversals, calendar, lead-lag, automated X/Y engine | declined — tracks done, X/Y engine declined; revisit at 3 y chain history (Claude 10-18) |
| [A121](asks/A121.md) | 2026-10-15 | Muse → Cursor | scoreboard.py: exception path rolls back DDL + all earlier checks, then crashes | done (Cursor fix; Claude ran the failing-check test 10-16: pass) |
| [A122](asks/A122.md) | 2026-10-15 | Muse → Cursor | Muse live status on the Stage orb grid (git heartbeat) | done (Cursor 10-16: muse.json + hooks on Stage; git-heartbeat fallback if Muse writes the file) |
| [A123](asks/A123.md) | 2026-10-15 | Muse → Cursor | Crawl4AI + Browser Use pilot (tested before filing) | done (Claude 10-16 v4: on-demand fetcher; Jamie approved) |
| [A124](asks/A124.md) | 2026-10-16 | Muse → Cursor | Pythia forecasting-oracle pilot (tested before filing) | done (Cursor 10-18: pythia Ollama → forecast_ledger; pilot scoring open) |
| [A125](asks/A125.md) | 2026-10-16 | Muse → Cursor | Video Lab tab: upload test shorts + co-generate ideas | declined (Muse A169 10-18: Video Lab removed from fildi; side project out of app) |
| [A126](asks/A126.md) | 2026-10-16 | Muse → Cursor | Order-flow-style chart indicators (volume profile, VWAP, volume) | parked (Cursor 10-18: 1m+5m shipped; Jamie UI eyeball) |
| [A127](asks/A127.md) | 2026-10-16 | Muse → Cursor | UI motion polish (Lenis + react-bits) | done (Cursor 10-18: Lenis + AnimatedNumber on Profile + track-record ScoreCard) |
| [A128](asks/A128.md) | 2026-10-16 | Muse → Cursor | Pilot codebase-memory-mcp (token reduction) | done (Claude 10-16: route-map + commit-impact scripts, no MCP) |
| [A129](asks/A129.md) | 2026-10-16 | Muse → Cursor | Pilot OpenJev calibrated-probability layer | local 26B live (Claude 10-16); first resolutions 10-17; pass test ≥ 50 resolved puts |
| [A130](asks/A130.md) | 2026-10-16 | Muse → Cursor | Pilot OmniRoute free-tier gateway | step 1 done (Claude 10-16: all Haiku calls logged + AI spend line) |
| [A131](asks/A131.md) | 2026-10-16 | Cursor → Claude | Backtest timestamp-leakage audit | done (Claude signed 10-18: S025 holds at t+1; S028 NFCI unsigned; S003 classify open) |
| [A132](asks/A132.md) | 2026-10-16 | Muse → Cursor | Competitive teardown: FinceptTerminal vs fildi | done (Muse 10-18: steal VaR → A160; park node editor; skip rest) |
| [A133](asks/A133.md) | 2026-10-16 | Muse → Cursor | Evaluate PentPort data API | parked (Cursor 10-18: blocked Jamie PentPort signup) |
| [A134](asks/A134.md) | 2026-10-16 | Muse → Cursor | Gamma exposure (GEX) regime indicator | done (phase 1; S034 + phase 2 parked) |
| [A135](asks/A135.md) | 2026-10-16 | Muse → Cursor | Merge Karpathy behavioral guidelines | done (Claude 10-16: AGENTS.md rule 8) |
| [A136](asks/A136.md) | 2026-10-16 | Muse → Cursor | Pre-trade risk gate | done (Cursor 10-17: badges + override log; backtest still open → Claude) |
| [A137](asks/A137.md) | 2026-10-16 | Muse → Cursor | Vol-mispricing signal E[RV] vs IV | declined (S033 FAIL 10-18: HAR adds +0.015 IV-fixed < 0.02 bar; revisit with intraday RV, A126) |
| [A138](asks/A138.md) | 2026-10-16 | Muse → Cursor | TimesFM pilot | declined (S033: HAR failed → TimesFM moot; revisit with A126 intraday RV) |
| [A139](asks/A139.md) | 2026-10-16 | Muse → Cursor | ICT indicator suite + rank-weighted composite | parked (Cursor 10-18: overlays shipped; S036 gates composite) |
| [A140](asks/A140.md) | 2026-10-17 | Muse → Grok | Post-down-day setup flag for scanner + options-book brief | open (routed Muse → Grok 2026-10-18; Grok pre-review only — quant signal, Claude final, not planned. A141 = standing Grok row) |
| [A141](asks/A141.md) | 2026-10-16 | Cursor → Grok | Standing: Grok Bot devil’s-advocate reviews (GROK.md) | open (Cursor 10-17: renumbered from A140 after Muse collision) |
| [A142](asks/A142.md) | 2026-10-17 | Grok → Claude | Grok Bot role + workflow proposals (Muse comment before any rule change) | planned (Claude 10-18) |
| [A143](asks/A143.md) | 2026-10-17 | Claude → Cursor | OpenJev overnight headline labels in Desk daily news (display only) | done (Cursor 10-18: smoke 72/72 labels in 52s; rollback fix) |
| [A144](asks/A144.md) | 2026-10-17 | Grok → Cursor | Review + merge PR #2 (Grok Bot fixes) into cursor/mac-dev | done (Cursor 10-17: reviewed + merged ci-auth-inbox-asks-b665) |
| [A145](asks/A145.md) | 2026-10-17 | Grok → Claude | CI phase 2 (from Grok Bot) | planned (Claude plan in file 10-18) |
| [A146](asks/A146.md) | 2026-10-17 | Claude → Cursor | [quant] analyst_events headline links: 35 % are generic roundups | done (Cursor 10-18: ticker-gate + roundup scrub on FMP feed; prior from headline) |
| [A147](asks/A147.md) | 2026-10-17 | Claude → Cursor | [quant] P1 data: 19 tickers in two peer groups + zero dividend yields (NEE DUK D AEP) | done (Cursor 10-17: override cleanup 10 duals; Yahoo0 yield skip — re-run merge-trusted) |
| [A148](asks/A148.md) | 2026-10-17 | Claude → Claude | [quant] Peer-group fixes from OpenJev audit + monthly peer audit | done (25 moves applied 10-18; ZTO TCOM held for China flag; monthly control open) |
| [A149](asks/A149.md) | 2026-10-17 | Claude → Cursor | Scenario exposure panel: who is hurt/helped if oil, rates, AI… move (display only) | done (Cursor 10-18: Live › Macro panel from scenarios.jsonl; betas next monthly bake) |
| [A150](asks/A150.md) | 2026-10-17 | Claude → all agents | OpenJev token-saving framework: registry, eval/verify, live audit | done (v1; Cursor verified P11→A; P10/P17/P21 stay B) · session: `oj.py pending` |
| [A151](asks/A151.md) | 2026-10-17 | Muse → Cursor | oj eval/verify crash on small or empty eval sets | done (Cursor 10-18: floor-5 sample + null empty score; tests) |
| [A152](asks/A152.md) | 2026-10-17 | Muse → Cursor | CI red on tip - A151 commits missing Agent: trailer | done (CI green 2026-10-18) |
| [A153](asks/A153.md) | 2026-10-18 | Claude → Cursor / Muse | NEEDS YOU comments answered by whichever agent is online (owner tag; Muse first responder) | done (Cursor 10-18) |
| [A154](asks/A154.md) | 2026-10-18 | Grok → Claude | [quant] Fund-score coverage: excluded metrics inflate the denominator | done (Claude shipped 10-18; tests 51/51) |
| [A155](asks/A155.md) | 2026-10-18 | Grok → Claude | [quant] One technical scorer — 6-comp champion vs 8-comp package | done (Cursor 10-18: 6-comp weights; extras display-only; top-20 overlap 13/20) |
| [A156](asks/A156.md) | 2026-10-18 | Grok → Claude | Decision: redact tracked session-state identifiers (forward only) | planned (Claude 10-18) |
| [A157](asks/A157.md) | 2026-10-18 | Grok → Claude | Grok Bot game plan: phases 0-5 for Claude, Muse, Cursor review | planned (Claude verified phases 10-18) |
| [A158](asks/A158.md) | 2026-10-18 | Grok → Cursor | Sync Mac checkout so Ideas shows A154-A157 and their Context blurbs | done (Cursor 10-18: sync up to date; HEAD bab270f ≥ 08d2e56c; Context present) |
| [A159](asks/A159.md) | 2026-10-18 | Claude → Cursor | [quant] Run study S041 — S/R v2 zones (handed off to save Claude tokens) | verified — reclassified FAIL (Claude 10-18: AUC is mechanical distance-to-floor; placebo levels 0.624) |
| [A161](asks/A161.md) | 2026-10-18 | Muse → Cursor | Portfolio VaR for the put-selling book (A132 winner) | done provisional (Cursor 10-18: MC 95/99 + −10% on Book card; Kupiec → S043) |
| [A162](asks/A162.md) | 2026-10-18 | Grok → Cursor | Read-only DB role + snapshot export for Grok audits (J6 option A first) | done stage 1 local (Cursor 10-18); remote + stage 2 need Jamie |
| [A163](asks/A163.md) | 2026-10-18 | Grok → Cursor | Live-app click audit session (read-only, Mac) | parked (Cursor 10-18: needs Jamie go that day for live click audit) |
| [A164](asks/A164.md) | 2026-10-18 | Grok → Muse | CodeGraph per-session cloud setup + Grok token-budget rules | done (Muse 10-18: measured — park per-session CodeGraph) |
| [A160](asks/A160.md) | 2026-10-18 | Claude → Cursor | [quant] Peer groups: merge waste→industrials, large+regional banks; GICS cross-check | done (merges Cursor; GICS cross-check + override fix Claude 10-18) |
| [A165](asks/A165.md) | 2026-10-18 | Cursor → Claude | OpenJev train loop — miss→teach→rebuild; Ideas readiness (P27) | planned — hold out taught items (Claude 10-18) |
| [A166](asks/A166.md) | 2026-10-18 | Cursor → Muse / Claude / Grok | Maintain fildi-feature-synthesis.md (gaps, synthesis, keep current) | open |
| [A167](asks/A167.md) | 2026-10-18 | Claude → Claude | [quant] Put-tuned tech score + nodeGap (options-1.1.0; S045 +15.7 bp/wk OOS) | done — options-1.1.0 live 10-18; grade at ≥ 8 expiries |
| [A168](asks/A168.md) | 2026-10-18 | Muse → Cursor | Fix CI api-server unit tests: video-lab-upload test hits dummy DATABASE_URL | open |
| [A169](asks/A169.md) | 2026-10-18 | Muse → Cursor | Remove Video Lab (A125) — side project, not fildi | done (Muse 10-18: removed directly) |
| [A170](asks/A170.md) | 2026-10-18 | Claude → Claude | [quant] S046 — re-test call side + Avoid list on their own outcomes (calls pnl, left tail) | done (Claude 10-18: S046 → options-1.2.0 calls live; Avoid flags = no crash edge beyond IV) |
| [A171](asks/A171.md) | 2026-10-18 | Claude → Claude | [quant] Scoreboard: four "is the app smarter?" numbers (Own−Avoid, FV spread, put Brier, IRA vs SPY/QQQ) | done (Claude 10-18: Settings › Research scoreboard; verdicts after ≥ 8 weeks) |
| [A172](asks/A172.md) | 2026-10-18 | Claude → Cursor | [quant] Shadow mode: store options-1.0.0 score beside 1.1.0, grade both live | planned (Claude plan 10-18) |
| [A173](asks/A173.md) | 2026-10-18 | Claude → Claude | Every new ASKS row names the scoreboard number it moves | done (Claude 10-18) |
| [A174](asks/A174.md) | 2026-10-18 | Claude → Claude | Portfolio Alerts: flag holdings on the Avoid list | done (Claude 10-18: amber bullet, live next pm_alerts run) |
| [A175](asks/A175.md) | 2026-10-18 | Claude → Cursor | [quant] Strategy Library page (Track Record › Strategies): filter, curve vs SPY, stats, trade log | done (Cursor 10-19; needs Muse+Claude commit review) |
| [A176](asks/A176.md) | 2026-10-18 | Claude → Claude | [quant] Strategy runner + tables, seeded with wheel / covered calls / Own−Avoid | done (Claude 10-19: 3 seeds, IRA replay = scoreboard exactly; S047) |
| [A177](asks/A177.md) | 2026-10-18 | Claude → Claude | [quant] 0DTE tail-lotto: do we have real intraday option prices? | done (Claude 10-19: S048 FAIL — 10 triggers, 0 winners; thin) |
| [A178](asks/A178.md) | 2026-10-18 | Claude → Claude | [quant] Panic put-selling after capitulation days vs normal wheel | done (Claude 10-19: S049 holdout +1.47 %/trade PASS; in-sample disagrees → candidate) |
| [A179](asks/A179.md) | 2026-10-19 | Cursor → Claude | Daily put-seller desk workflow UX (Today strip, ticker Open Options, trust chrome) | open |
| [A180](asks/A180.md) | 2026-10-19 | Cursor → Claude | DB-first shell for Breakdown / quote / compare (cut request-path Yahoo) | done (Cursor 10-19) |
| [A181](asks/A181.md) | 2026-10-19 | Cursor → Claude | Price chart history ≥1W from prices_historical (not Yahoo chart) | done (Cursor 10-19) |
| [A182](asks/A182.md) | 2026-10-19 | Cursor → Claude | LazyMount Breakdown PriceChart (defer history fetch) | done (Cursor 10-19) |
| [A183](asks/A183.md) | 2026-10-19 | Claude → Claude | [quant] Sector laggard catch-up (peer group rallies/crashes, one member lags) | done (Claude 10-19: S050 FAIL — laggards keep lagging, n.s.) |
| [A184](asks/A184.md) | 2026-10-19 | Claude → Claude | [quant] Strategy backlog: ORB, intraday momentum, FVG, revisions drift, trend, 52w high, RSI(2), squeeze, GEX | open |
| [A185](asks/A185.md) | 2026-10-19 | Claude → Cursor | Polygon budget: Node polygon-limiter.ts joins the shared cross-process gate | open |
| [A186](asks/A186.md) | 2026-10-19 | Cursor → Claude | [quant] Simulated Rec W-L when no graded model_recs (backtest fill, labeled sim) | planned (Claude plan 10-19: 52-wk 1σ-put OTM base rate, labeled sim; stop rule at 100 graded) |
| [A187](asks/A187.md) | 2026-10-19 | Cursor → Claude | Enhance Options SIG beyond V2 technical gate (fit / Opt / regime)? | declined (Claude 10-19: composite method; panic-put badge A189 + regime dial cover the need) |
| [A188](asks/A188.md) | 2026-10-19 | Claude → Claude | [quant] Intraday mispricing list (research-based): option day/night, EOD hedging momentum, 0DTE regime, opex pinning, liquidity reversal, pre-FOMC | open |
| [A189](asks/A189.md) | 2026-10-19 | Claude → Cursor | Show live "Panic puts, high IV" signals (Strategies tab panel + Options board badge) | planned (Claude plan 10-19; after A175) |
| [A190](asks/A190.md) | 2026-10-19 | Claude → Cursor | House view card: daily odds + coherence warnings (Portfolio Alerts + Model List) | planned |
| [A191](asks/A191.md) | 2026-10-19 | Claude → Cursor | [quant] Port S059 put edge into the TS option score (options-1.3.0 shadow) | planned |
| [A192](asks/A192.md) | 2026-10-19 | Claude → Claude | [quant] Rank every major option structure (Structures tab): plan v2 + Phase 0 skew survey | accepted |
| [A193](asks/A193.md) | 2026-10-19 | Muse → Cursor | skew_survey.py crashes on calendar-hole days (unguarded monthly expiry min()) | done |
| [A194](asks/A194.md) | 2026-10-19 | Muse → Cursor | Schwab 1m bars + WRDS OptionMetrics check | done (Cursor 10-20 row 1) · row 2 declined |
| [A195](asks/A195.md) | 2026-10-19 | Muse → Claude | [quant] Cointegration divergence as put-selling entry signal — study | open |
| [A196](asks/A196.md) | 2026-10-19 | Muse → Claude | [quant] Visser trend/momentum filter for put entries — study | open |
| [A197](asks/A197.md) | 2026-10-20 | Muse → Cursor | ci-guards: brief-only (commentary/) commits fail Agent-trailer rule → CI red at tip | open |
| [A198](asks/A198.md) | 2026-10-20 | Muse → Cursor | Stock Breakdown scroll fix — DONE (restored from A179 after ID collision) | done |
| [A199](asks/A199.md) | 2026-10-20 | Muse → Cursor | Pre-Dec-11 build capacity plan (restored from A180 after ID collision) | open |
| [A200](asks/A200.md) | 2026-10-20 | Muse → Cursor | Peer-group drift monitor (restored from A181 after ID collision) | open |
| [A201](asks/A201.md) | 2026-10-20 | Muse → Cursor | Model-version promotion protocol (restored from A182 after ID collision) | open |
| [A202](asks/A202.md) | 2026-10-20 | Muse → Cursor | Test: TradingView MCP bridge as chart layer (fildi keeps chains) | open |
| [A203](asks/A203.md) | 2026-10-20 | Muse → Claude | Jev corpus check — done by Muse: no corpus exists; fildi already runs the pattern (OpenJev) | done (killed at step 1) |
| [A204](asks/A204.md) | 2026-10-20 | Muse → Claude | [quant] Trend-state throttle for put selling (2/151 series) — study | open |
| [A205](asks/A205.md) | 2026-10-19 | Jamie → Codex | Integrate Codex into AI Stage, Ideas and claimed development | partial (Codex 10-19: desktop main activity observed in signed-in Stage; helper coverage pending) |
| [A206](asks/A206.md) | 2026-10-19 | Codex → Codex | [quant] Validate financial assessment before extending put-edge claims | partial (Codex 10-20: Focus/calendar fixes tested; financial recalibration pending) |
| [A207](asks/A207.md) | 2026-10-19 | Codex → Codex | Bounded autonomous development and access visibility | open |
| [A208](asks/A208.md) | 2026-10-19 | Codex → Claude | Material decision changes using existing action tickets | open (fixture-first plan; review pending) |
| [A209](asks/A209.md) | 2026-10-20 | Jamie → Cursor | Agent learn feed — turn metrics + shared optimization loop | accepted (Jamie chat; P0–P3 in file) |
| [A210](asks/A210.md) | 2026-10-20 | Claude → Cursor, Codex, Grok, Muse | Workflow learning loop for all agents (W-registry, token audit) + AGENTS.md dedupe + commit-review drift | open |
