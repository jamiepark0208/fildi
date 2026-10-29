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
| [A107](asks/A107.md) | 2026-10-15 | Muse → Cursor | GS Quant evaluation: borrow Goldman's derivatives toolkit | declined (folded into A54 — Claude 10-15: offline Greeks test there; GS Quant needs Marquee) |
| [A108](asks/A108.md) | 2026-10-15 | Muse → Cursor | OpenAlice teardown: borrow the lifecycle, not the autonomy | declined (Claude 10-15: exit rules are S017 + A92) |
| [A109](asks/A109.md) | 2026-10-15 | Muse → Cursor | Market microstructure toolkit survey (gamma/dealer research) | parked (Claude 10-15: no index chains; tick data costs money) |
| [A110](asks/A110.md) | 2026-10-15 | Muse → Cursor | option_history.py re-run hazards: optlab.bars schema has no migration; chain cache not keyed on ref | done (Claude fixed 10-15) |
| [A111](asks/A111.md) | 2026-10-15 | Muse → Cursor | iv_rank min-history 120→60d changed silently in 9bee2472 — document or revert | done (Claude fixed 10-15) |
| [A112](asks/A112.md) | 2026-10-15 | Muse → Cursor | pm_alerts.py DDL.split(';') runs a trailing empty statement (startup crash risk) | done (Claude fixed 10-15) |
| [A115](asks/A115.md) | 2026-10-15 | Muse → Cursor | Trend-efficiency regime filter for premium selling | parked (Cursor 10-18: regime bake-off study with A117/A56 before filter) |
| [A116](asks/A116.md) | 2026-10-15 | Muse → Cursor | Agent-tooling roundup: adopt the good skills, vet the rest | done (Cursor 10-28: ToB-style audit — env ignored; pnpm 1 critical transitive) |
| [A117](asks/A117.md) | 2026-10-15 | Muse → Cursor | Backend quant-algorithm inventory: map the classics to fildi gaps | done — PCA + early-assign + Cholesky MC (Cursor 10-18); regime bake-off → A115 |
| [A118](asks/A118.md) | 2026-10-15 | Muse → Cursor | Extended agent-tooling evaluation (archify, trail of bits, spec kit, taskmaster, serena) | declined (merged into A116 — Claude 10-16) |
| [A119](asks/A119.md) | 2026-10-15 | Muse → Cursor | Personal AI agent landscape: free-tier use cases (hermes, openclaw, grokbot, dots, instinct) | parked (Claude 10-16: Hermes vs SkillOpt waits on A103's trigger) |
| [A120](asks/A120.md) | 2026-10-15 | Muse → Claude | [quant] Pattern-discovery research program: regimes, reversals, calendar, lead-lag, automated X/Y engine | declined — tracks done, X/Y engine declined; revisit at 3 y chain history (Claude 10-18) |
| [A121](asks/A121.md) | 2026-10-15 | Codex → Cursor | scoreboard.py: exception path rolls back DDL + all earlier checks, then crashes | done (Cursor 10-27: check_key upsert + twin merge + last_error UI) |
| [A122](asks/A122.md) | 2026-10-15 | Muse → Cursor | Muse live status on the Stage orb grid (git heartbeat) | done (Cursor 10-16: muse.json + hooks on Stage; git-heartbeat fallback if Muse writes the file) |
| [A123](asks/A123.md) | 2026-10-15 | Muse → Cursor | Crawl4AI + Browser Use pilot (tested before filing) | done (Claude 10-16 v4: on-demand fetcher; Jamie approved) |
| [A124](asks/A124.md) | 2026-10-16 | Muse → Cursor | Pythia forecasting-oracle pilot (tested before filing) | declined (Claude 10-26: bare no-input LLM prompt, Ollama never installed, 0 rows; hook retired) |
| [A125](asks/A125.md) | 2026-10-16 | Muse → Cursor | Video Lab tab: upload test shorts + co-generate ideas | declined (Muse A169 10-18: Video Lab removed from fildi; side project out of app) |
| [A126](asks/A126.md) | 2026-10-16 | Muse → Cursor | Order-flow-style chart indicators (volume profile, VWAP, volume) | parked (Cursor 10-18: 1m+5m shipped; Jamie UI eyeball) |
| [A127](asks/A127.md) | 2026-10-16 | Muse → Cursor | UI motion polish (Lenis + react-bits) | done (Cursor 10-18: Lenis + AnimatedNumber on Profile + track-record ScoreCard) |
| [A128](asks/A128.md) | 2026-10-16 | Muse → Cursor | Pilot codebase-memory-mcp (token reduction) | done (Claude 10-16: route-map + commit-impact scripts, no MCP) |
| [A129](asks/A129.md) | 2026-10-16 | Muse → Cursor | Pilot OpenJev calibrated-probability layer | done (forecast batch parked 10-24 FORECAST_BATCH=False — loses to baseline; on-demand + A261 shortlist keep) |
| [A130](asks/A130.md) | 2026-10-16 | Muse → Cursor | Pilot OmniRoute free-tier gateway | accepted (step 1 done 10-16: Haiku calls logged + AI spend line) |
| [A131](asks/A131.md) | 2026-10-16 | Cursor → Claude | Backtest timestamp-leakage audit | done (Claude signed 10-18: S025 holds at t+1; S028 NFCI unsigned; S003 classify open) |
| [A132](asks/A132.md) | 2026-10-16 | Muse → Cursor | Competitive teardown: FinceptTerminal vs fildi | done (Muse 10-18: steal VaR → A160; park node editor; skip rest) |
| [A133](asks/A133.md) | 2026-10-16 | Muse → Cursor | Evaluate PentPort data API | parked (Cursor 10-18: blocked Jamie PentPort signup) |
| [A134](asks/A134.md) | 2026-10-16 | Muse → Cursor | Gamma exposure (GEX) regime indicator | done (phase 1) · S034 unparked 10-20, queued for Claude · phase 2 parked |
| [A135](asks/A135.md) | 2026-10-16 | Muse → Cursor | Merge Karpathy behavioral guidelines | done (Claude 10-16: AGENTS.md rule 8) |
| [A136](asks/A136.md) | 2026-10-16 | Muse → Cursor | Pre-trade risk gate | done (Cursor 10-17: badges + override log; backtest still open → Claude) |
| [A137](asks/A137.md) | 2026-10-16 | Muse → Cursor | Vol-mispricing signal E[RV] vs IV | declined (S033 FAIL 10-18: HAR adds +0.015 IV-fixed < 0.02 bar; revisit with intraday RV, A126) |
| [A138](asks/A138.md) | 2026-10-16 | Muse → Cursor | TimesFM pilot | declined (S033: HAR failed → TimesFM moot; revisit with A126 intraday RV) |
| [A139](asks/A139.md) | 2026-10-16 | Muse → Cursor | ICT indicator suite + rank-weighted composite | parked (Cursor 10-18: overlays shipped; S036 gates composite) |
| [A140](asks/A140.md) | 2026-10-17 | Muse → Grok | Post-down-day setup flag for scanner + options-book brief | needs Jamie |
| [A141](asks/A141.md) | 2026-10-16 | Cursor → Grok | Standing: Grok Bot devil’s-advocate reviews (GROK.md) | parked — standing (Grok review lane definition, not a task; aging-exempt) |
| [A142](asks/A142.md) | 2026-10-17 | Grok → Claude | Grok Bot role + workflow proposals (Muse comment before any rule change) | done (decided 10-18: Jamie GO + Claude plan + Muse review; residue claims display → Cursor) |
| [A143](asks/A143.md) | 2026-10-17 | Claude → Cursor | OpenJev overnight headline labels in Desk daily news (display only) | done (Cursor 10-18: smoke 72/72 labels in 52s; rollback fix) |
| [A144](asks/A144.md) | 2026-10-17 | Grok → Cursor | Review + merge PR #2 (Grok Bot fixes) into cursor/mac-dev | done (Cursor 10-17: reviewed + merged ci-auth-inbox-asks-b665) |
| [A145](asks/A145.md) | 2026-10-17 | Grok → Claude | CI phase 2 (from Grok Bot) | done (Cursor 10-21: gates 5–8 in ci.yml + ci-guards) |
| [A146](asks/A146.md) | 2026-10-17 | Claude → Cursor | [quant] analyst_events headline links: 35 % are generic roundups | done (Cursor 10-18: ticker-gate + roundup scrub on FMP feed; prior from headline) |
| [A147](asks/A147.md) | 2026-10-17 | Claude → Cursor | [quant] P1 data: 19 tickers in two peer groups + zero dividend yields (NEE DUK D AEP) | done (Cursor 10-17: override cleanup 10 duals; Yahoo0 yield skip — re-run merge-trusted) |
| [A148](asks/A148.md) | 2026-10-17 | Claude → Claude | [quant] Peer-group fixes from OpenJev audit + monthly peer audit | done (25 moves applied 10-18; ZTO TCOM held for China flag; monthly control open) |
| [A149](asks/A149.md) | 2026-10-17 | Claude → Cursor | Scenario exposure panel: who is hurt/helped if oil, rates, AI… move (display only) | done (Cursor 10-21: betas baked + book coverage fix) |
| [A150](asks/A150.md) | 2026-10-17 | Claude → all agents | OpenJev token-saving framework: registry, eval/verify, live audit | done (v1; Cursor verified P11→A; P10/P17/P21 stay B) · session: `oj.py pending` |
| [A151](asks/A151.md) | 2026-10-17 | Muse → Cursor | oj eval/verify crash on small or empty eval sets | done (Cursor 10-18: floor-5 sample + null empty score; tests) |
| [A152](asks/A152.md) | 2026-10-17 | Muse → Cursor | CI red on tip - A151 commits missing Agent: trailer | done (CI green 2026-10-18) |
| [A153](asks/A153.md) | 2026-10-18 | Claude → Cursor / Muse | NEEDS YOU comments answered by whichever agent is online (owner tag; Muse first responder) | done (Cursor 10-18) |
| [A154](asks/A154.md) | 2026-10-18 | Grok → Claude | [quant] Fund-score coverage: excluded metrics inflate the denominator | done (Claude shipped 10-18; tests 51/51) |
| [A155](asks/A155.md) | 2026-10-18 | Grok → Claude | [quant] One technical scorer — 6-comp champion vs 8-comp package | done (Cursor 10-18: 6-comp weights; extras display-only; top-20 overlap 13/20) |
| [A156](asks/A156.md) | 2026-10-18 | Grok → Claude | Decision: redact tracked session-state identifiers (forward only) | done (Claude state.md + Cursor kiro 10-21; forward-only) |
| [A157](asks/A157.md) | 2026-10-18 | Grok → Claude | Grok Bot game plan: phases 0-5 for Claude, Muse, Cursor review | planned (Claude verified phases 10-18) |
| [A158](asks/A158.md) | 2026-10-18 | Grok → Cursor | Sync Mac checkout so Ideas shows A154-A157 and their Context blurbs | done (Cursor 10-18: sync up to date; HEAD bab270f ≥ 08d2e56c; Context present) |
| [A159](asks/A159.md) | 2026-10-18 | Claude → Cursor | [quant] Run study S041 — S/R v2 zones (handed off to save Claude tokens) | verified — reclassified FAIL (Claude 10-18: AUC is mechanical distance-to-floor; placebo levels 0.624) |
| [A161](asks/A161.md) | 2026-10-18 | Muse → Cursor | Portfolio VaR for the put-selling book (A132 winner) | done provisional (Cursor 10-18: MC 95/99 + −10% on Book card; Kupiec → S043) |
| [A162](asks/A162.md) | 2026-10-18 | Grok → Cursor | Read-only DB role + snapshot export for Grok audits (J6 option A first) | done stage 1 local (Cursor 10-18); remote + stage 2 need Jamie |
| [A163](asks/A163.md) | 2026-10-18 | Grok → Cursor | Live-app click audit session (read-only, Mac) | parked (Cursor 10-18: needs Jamie go that day for live click audit) |
| [A164](asks/A164.md) | 2026-10-18 | Grok → Muse | CodeGraph per-session cloud setup + Grok token-budget rules | done (Muse 10-18: measured — park per-session CodeGraph) |
| [A160](asks/A160.md) | 2026-10-18 | Claude → Cursor | [quant] Peer groups: merge waste→industrials, large+regional banks; GICS cross-check | done (merges Cursor; GICS cross-check + override fix Claude 10-18) |
| [A165](asks/A165.md) | 2026-10-18 | Cursor → Claude → Cursor | OpenJev train loop — miss→teach→rebuild; Ideas readiness (P27) | parked (Claude 10-29, A312: not put/call pnl; revisit after 12-11 token cliff) |
| [A166](asks/A166.md) | 2026-10-18 | Cursor → Muse / Claude / Grok | Maintain fildi-feature-synthesis.md (gaps, synthesis, keep current) | parked (Claude 10-29, A312: not put/call pnl; revisit after 12-11 token cliff) |
| [A167](asks/A167.md) | 2026-10-18 | Claude → Claude | [quant] Put-tuned tech score + nodeGap (options-1.1.0; S045 +15.7 bp/wk OOS) | done — options-1.1.0 live 10-18; grade at ≥ 8 expiries |
| [A168](asks/A168.md) | 2026-10-18 | Muse → Cursor | Fix CI api-server unit tests: video-lab-upload test hits dummy DATABASE_URL | declined (need met by A169; Cursor 10-20) |
| [A169](asks/A169.md) | 2026-10-18 | Muse → Cursor | Remove Video Lab (A125) — side project, not fildi | done (Muse 10-18: removed directly) |
| [A170](asks/A170.md) | 2026-10-18 | Claude → Claude | [quant] S046 — re-test call side + Avoid list on their own outcomes (calls pnl, left tail) | done (Claude 10-18: S046 → options-1.2.0 calls live; Avoid flags = no crash edge beyond IV) |
| [A171](asks/A171.md) | 2026-10-18 | Claude → Claude | [quant] Scoreboard: four "is the app smarter?" numbers (Own−Avoid, FV spread, put Brier, IRA vs SPY/QQQ) | done (Claude 10-18: Settings › Research scoreboard; verdicts after ≥ 8 weeks) |
| [A172](asks/A172.md) | 2026-10-18 | Claude → Cursor | [quant] Shadow mode: store options-1.0.0 score beside 1.1.0, grade both live | done |
| [A173](asks/A173.md) | 2026-10-18 | Claude → Claude | Every new ASKS row names the scoreboard number it moves | done (Claude 10-18) |
| [A174](asks/A174.md) | 2026-10-18 | Claude → Claude | Portfolio Alerts: flag holdings on the Avoid list | done (Claude 10-18: amber bullet, live next pm_alerts run) |
| [A175](asks/A175.md) | 2026-10-18 | Claude → Cursor | [quant] Strategy Library page (Track Record › Strategies): filter, curve vs SPY, stats, trade log | done (Cursor 10-19; needs Muse+Claude commit review) |
| [A176](asks/A176.md) | 2026-10-18 | Claude → Claude | [quant] Strategy runner + tables, seeded with wheel / covered calls / Own−Avoid | done (Claude 10-19: 3 seeds, IRA replay = scoreboard exactly; S047) |
| [A177](asks/A177.md) | 2026-10-18 | Claude → Claude | [quant] 0DTE tail-lotto: do we have real intraday option prices? | done (Claude 10-19: S048 FAIL — 10 triggers, 0 winners; thin) |
| [A178](asks/A178.md) | 2026-10-18 | Claude → Claude | [quant] Panic put-selling after capitulation days vs normal wheel | done (Claude 10-19: S049 holdout +1.47 %/trade PASS; in-sample disagrees → candidate) |
| [A179](asks/A179.md) | 2026-10-19 | Cursor → Claude → Cursor | Daily put-seller desk workflow UX (Today strip, ticker Open Options, trust chrome) | done (Cursor 10-28: strip as-of/calendar, ?ticker= scoped Options, VIX stale + shared wr label) |
| [A180](asks/A180.md) | 2026-10-19 | Cursor → Claude | DB-first shell for Breakdown / quote / compare (cut request-path Yahoo) | done (Cursor 10-19) |
| [A181](asks/A181.md) | 2026-10-19 | Cursor → Claude | Price chart history ≥1W from prices_historical (not Yahoo chart) | done (Cursor 10-19) |
| [A182](asks/A182.md) | 2026-10-19 | Cursor → Claude | LazyMount Breakdown PriceChart (defer history fetch) | done (Cursor 10-19) |
| [A183](asks/A183.md) | 2026-10-19 | Claude → Claude | [quant] Sector laggard catch-up (peer group rallies/crashes, one member lags) | done (Claude 10-19: S050 FAIL — laggards keep lagging, n.s.) |
| [A184](asks/A184.md) | 2026-10-19 | Claude → Claude | [quant] Strategy backlog: ORB, intraday momentum, FVG, revisions drift, trend, 52w high, RSI(2), squeeze, GEX | open |
| [A185](asks/A185.md) | 2026-10-19 | Claude → Cursor | Polygon budget: Node polygon-limiter.ts joins the shared cross-process gate | done (Cursor 10-20) |
| [A186](asks/A186.md) | 2026-10-19 | Cursor → Claude → Cursor | [quant] Simulated Rec W-L when no graded model_recs (backtest fill, labeled sim) | done (Cursor 10-27: simRec on by-ticker + grey · sim badge) |
| [A187](asks/A187.md) | 2026-10-19 | Cursor → Claude | Enhance Options SIG beyond V2 technical gate (fit / Opt / regime)? | declined (Claude 10-19: composite method; panic-put badge A189 + regime dial cover the need) |
| [A188](asks/A188.md) | 2026-10-19 | Claude → Claude | [quant] Intraday mispricing list (research-based): option day/night, EOD hedging momentum, 0DTE regime, opex pinning, liquidity reversal, pre-FOMC | open |
| [A189](asks/A189.md) | 2026-10-19 | Claude → Cursor | Show live "Panic puts, high IV" signals (Strategies tab panel + Options board badge) | done (Cursor 10-20) |
| [A190](asks/A190.md) | 2026-10-19 | Claude → Cursor | House view card: daily odds + coherence warnings (Portfolio Alerts + Model List) | done (Cursor 10-20) |
| [A191](asks/A191.md) | 2026-10-19 | Claude → Cursor | [quant] Port S059 put edge into the TS option score (options-1.3.0 shadow) | done |
| [A192](asks/A192.md) | 2026-10-19 | Claude → Claude | [quant] Rank every major option structure (Structures tab): plan v2 + Phase 0 skew survey | accepted (Phase 0 running) |
| [A193](asks/A193.md) | 2026-10-19 | Muse → Cursor | skew_survey.py crashes on calendar-hole days (unguarded monthly expiry min()) | done |
| [A194](asks/A194.md) | 2026-10-19 | Muse → Cursor | Schwab 1m bars + WRDS OptionMetrics check | done (Cursor 10-20 row 1) · row 2 declined |
| [A195](asks/A195.md) | 2026-10-19 | Muse → Claude → Cursor | [quant] Cointegration divergence as put-selling entry signal — study | done (Cursor 10-28: S134 power-gate FAIL)|
| [A196](asks/A196.md) | 2026-10-19 | Muse → Claude | [quant] Visser trend/momentum filter for put entries — study | done (S073 FAIL) |
| [A197](asks/A197.md) | 2026-10-20 | Muse → Cursor | ci-guards: brief-only (commentary/) commits fail Agent-trailer rule → CI red at tip | done |
| [A198](asks/A198.md) | 2026-10-20 | Muse → Cursor | Stock Breakdown scroll fix — DONE (restored from A179 after ID collision) | done |
| [A199](asks/A199.md) | 2026-10-20 | Muse → Cursor | Pre-Dec-11 build capacity plan (restored from A180 after ID collision) | done (matrix; Jamie kill/park tap) |
| [A200](asks/A200.md) | 2026-10-20 | Muse → Cursor | [quant] Peer-group drift monitor (restored from A181 after ID collision) | done (Cursor 10-28: peer:drift PM alert from peers_review; mute >30%; HOOD dry-run 1/910) |
| [A201](asks/A201.md) | 2026-10-20 | Muse → Cursor | Model-version promotion protocol (restored from A182 after ID collision) | done (protocol; 1.2.0 hold) |
| [A202](asks/A202.md) | 2026-10-20 | Muse → Cursor | Test: TradingView MCP bridge as chart layer (fildi keeps chains) | declined (park; S045 + fetch-page A139) |
| [A203](asks/A203.md) | 2026-10-20 | Muse → Claude | Jev corpus check — done by Muse: no corpus exists; fildi already runs the pattern (OpenJev) | done (killed at step 1) |
| [A204](asks/A204.md) | 2026-10-20 | Muse → Claude | [quant] Trend-state throttle for put selling (2/151 series) — study | done (S073 FAIL) |
| [A205](asks/A205.md) | 2026-10-19 | Jamie → Codex | Integrate Codex into AI Stage, Ideas and claimed development | partial (Codex 10-19: desktop main activity observed in signed-in Stage; helper coverage pending) |
| [A206](asks/A206.md) | 2026-10-19 | Codex → Codex | [quant] Validate financial assessment before extending put-edge claims | partial (Codex 10-20: Focus/calendar fixes tested; financial recalibration pending) |
| [A207](asks/A207.md) | 2026-10-19 | Codex → Cursor | Bounded autonomous development and access visibility | parked (Claude 10-29, A312: not put/call pnl; revisit after 12-11 token cliff) |
| [A208](asks/A208.md) | 2026-10-19 | Codex → Claude | Material decision changes using existing action tickets | planned |
| [A209](asks/A209.md) | 2026-10-20 | Jamie → Cursor | Agent learn feed — turn metrics + shared optimization loop | done (P0–P3) |
| [A210](asks/A210.md) | 2026-10-20 | Claude → Cursor, Codex, Grok, Muse | Workflow learning loop for all agents (W-registry, token audit) + AGENTS.md dedupe + commit-review drift | parked (Claude 10-29, A312: not put/call pnl; revisit after 12-11 token cliff) |
| [A211](asks/A211.md) | 2026-10-20 | Grok → Cursor | Split Fildi jobs into Mac-private vs host-portable public-data jobs (prep for always-on server). | done (stage 1 inventory; RSS partial) |
| [A212](asks/A212.md) | 2026-10-20 | Codex → Claude | Review S064 buy-zone puts, S066 earnings block, S049-crash re-audit (Jamie: skeptical of Research tab) | done (Cursor 10-28: S064 rerun; HINT display — Claude judges)|
| [A213](asks/A213.md) | 2026-10-20 | Claude → Cursor | Model List odds panel: P(OTM), P(profit), P(touch), expiry range, if-assigned, bounce base rate — data in watchlist_sync.pick_odds | done |
| [A214](asks/A214.md) | 2026-10-20 | Jamie → Cursor | Desk media sentiment for Breakdown › Sentiment (StockTwits/X/Reddit/OpenJev — not Yahoo recs) | done |
| [A215](asks/A215.md) | 2026-10-20 | Claude → Cursor | Source/last-updated tooltip: show stale vs job cadence (data_freshness.py CHECKS) | done |
| [A216](asks/A216.md) | 2026-10-20 | Claude → Cursor | StructuresBoard: keep Claude's plain-language headers + hover tips when committing your redesign | done |
| [A217](asks/A217.md) | 2026-10-20 | Muse → Claude | [quant] Breeden–Litzenberger implied density from Schwab chains — study (Q vs empirical P gap; A213 implied column) | done (S077 FAIL — display only; Claude 10-26) |
| [A218](asks/A218.md) | 2026-10-20 | Muse → Cursor | Test: Orca fleet console for the agent roster + Headroom token-compression check | declined — rebutted by Muse 10-22 (Jamie ruling), awaiting re-review |
| [A219](asks/A219.md) | 2026-10-20 | Muse → Claude → Cursor | [quant] Market-maker tier-list priors: ORB reconciliation (S056), VIX mean-reversion overlay, VWAP-MR timing, sizing rules | planned (Claude 10-29, A312 narrowed: VWAP timing + VIX overlay only; ORB declined) |
| [A220](asks/A220.md) | 2026-10-20 | Muse → Claude | [quant] IV-wall coverage calibration: strike floor + wall-test defense | done — display column shipped (Claude 10-21) |
| [A221](asks/A221.md) | 2026-10-20 | Muse → Claude → Cursor | [quant] Book concentration: covariance clusters, marginal risk at entry, equal-risk sizing | done (Cursor 10-28: S140 FAIL cluster cap)|
| [A222](asks/A222.md) | 2026-10-20 | Muse → Claude → Cursor | [quant] Qlib downside-label underlying ranking as a score factor | done (Cursor 10-28: S141 FAIL)|
| [A223](asks/A223.md) | 2026-10-20 | Muse → Claude | Pilot: NautilusTrader as study engine (re-run S064, three gates) | declined — rebutted by Muse 10-22 (Jamie ruling), awaiting re-review |
| [A224](asks/A224.md) | 2026-10-20 | Muse → Cursor | Test: Vibe-Trading — Shadow Account on Jamie's journal, alpha-zoo funnel, options cross-check | declined — rebutted by Muse 10-22 (Jamie ruling), awaiting re-review |
| [A225](asks/A225.md) | 2026-10-20 | Muse → Cursor | Test: Superpowers + Claude Mem gated installs (Mac lane weak spots) | parked (Superpowers deferred; Mem declined) |
| [A226](asks/A226.md) | 2026-10-21 | Muse → Cursor | Bug: StructureLab imports missing @/components/data-tip — CI Typecheck red since 0843d076 | done (Claude 10-21) |
| [A227](asks/A227.md) | 2026-10-21 | Muse → Grok + Claude | REVIEW: Muse's Oct 20 reel-batch rejections — challenge every one (18 items) | needs Jamie |
| [A228](asks/A228.md) | 2026-10-21 | Muse → Claude + Cursor | WRDS + LSEG: usage audit, entitled-but-unused inventory, adoption workstreams W1–W8 | split 10-24 → A264 (W8 panel), A265 (W2 CBOE), W4 = A262 S092; W1/W3/W5–W7 parked |
| [A229](asks/A229.md) | 2026-10-21 | Claude → all agents | Pipeline schedule changes: 05:00 PT data chain, list ≥ 07:00 PT, retries, OpenJev/transcripts timing | done (FYI) |
| [A230](asks/A230.md) | 2026-10-21 | Jamie → Claude → Cursor | [quant] Live forecast quality — Kalshi 15m + multi-signal calibration study | planned (Claude 10-29, A312 narrowed: Kalshi candles only when history already stored) |
| [A231](asks/A231.md) | 2026-10-21 | Muse → Cursor | CI red on tip — ASKS rows A214/A230 link missing ask files (a219961e) | done (Muse 10-21: files restored from Mac working tree) |
| [A232](asks/A232.md) | 2026-10-21 | Muse → Claude → Cursor | [quant] Earnings read-across: surprise transfer across peer/supplier chains (price / revisions / IV) | done (Cursor 10-28: S135 PASS b+c; Claude for wire)|
| [A233](asks/A233.md) | 2026-10-21 | Muse → Grok + Claude | Fildi monetization: two-world split, data-supply rebuild, multi-user architecture | revise |
| [A234](asks/A234.md) | 2026-10-21 | Muse → Grok + Claude + Codex | Agent framework hardening: dynamic plan/build/verify, agent-to-agent comms, token orchestration, cross-training loop | revise |
| [A235](asks/A235.md) | 2026-10-21 | Muse → Cursor | Permission hardening: close verified gate gaps (Schwab OAuth, research lanes, sdm, sessions) — pre-invite P0 | done (P0+P1+P2; await review) |
| [A236](asks/A236.md) | 2026-10-21 | Claude → Cursor | Pipeline follow-ups: verify 05:00 run, late-open list-first, precompute 29 min, Finnhub limit, request audit | done |
| [A237](asks/A237.md) | 2026-10-21 | Muse → Claude → Cursor | [quant] Neocloud contagion: oversold quality peers after a CRWV-led selloff — relative-value + put-premium study | parked (Claude 10-29, A312: put leg closed; revisit when point-in-time Compustat lands) |
| [A238](asks/A238.md) | 2026-10-21 | Claude → Cursor | Heavy-token queue: Cursor runs reviews-packets/backtests/studies, Claude judges from ≤ 20-line packets | done (Claude 10-29, A312: packet split is standard practice) |
| [A239](asks/A239.md) | 2026-10-21 | Claude → Cursor | Stage tab: draw Claude → Cursor/Grok dispatch beams (cursor-agent wrapper + parent tag) | done (Cursor 10-21) |
| [A240](asks/A240.md) | 2026-10-21 | Claude → Cursor | [quant] Earnings dates missing for ~23 % of put candidates (NEM FCX UPS ETN…) → re-strike skipped | done |
| [A241](asks/A241.md) | 2026-10-21 | Grok → Cursor | GCP free VM shadow: public jobs + public DB copy, Mac untouched until parity pass + Jamie go | stopped — do not continue (Jamie 10-26; VM TERMINATED) |
| [A242](asks/A242.md) | 2026-10-22 | Muse → Cursor | CI red on cursor/mac-dev: fix StructuresBoard imports (formatMd, ticker-link) + gitleaks allowlist for MISSING_UPCOMING_EMPTY_KEY | done (Cursor 10-22: gitleaks allowlist; formatMd+ticker-link already on tip) |
| [A243](asks/A243.md) | 2026-10-22 | Claude → Cursor | [quant] Model List stability: keep ideas until they break, daily scores, no cash gate, long call/put sections | done (Cursor 10-22: freshness+universe gate+carry+cash; LSEG RIC expand optional) |
| [A244](asks/A244.md) | 2026-10-22 | Jamie → Claude → Cursor | [quant] Long calls/puts: research-merged strategy (direction × timing × price), study, then Model List/Live/Rankings/Track record | parked (Claude 10-29, A312: S133 FAIL; paper board stays; revisit = revisions + 60-day calls beat buy-all after ±25 % call-cost stress, both halves) |
| [A245](asks/A245.md) | 2026-10-22 | Jamie → Claude → Cursor | [quant] What preceded real lows/highs: swing-extrema study vs look-alike crashes (feeds A244) | done (S082 PASS packet; Claude freeze/product) |
| [A246](asks/A246.md) | 2026-10-24 | Muse → Claude → Cursor | [quant] Closed-loop strategy self-improvement: generate → backtest → promote/demote with validation gates (paper-only) | planned (Claude 10-29, A312 narrowed: phase 1 only, false-winner gate) |
| [A247](asks/A247.md) | 2026-10-24 | Muse → Claude → Cursor | [quant] American-option pricer as fair-value validation: binomial + FD reference vs chain mids | declined |
| [A248](asks/A248.md) | 2026-10-24 | Claude → Cursor | RBH export: 60 stale assignment_sell false positives; find root cause + check patch hides no real assignment | done (net-exit gate; 63 empty rows left for Claude) |
| [A249](asks/A249.md) | 2026-10-24 | Claude → Grok | Red-team A248: symbol-level suppression of assignment warnings | done (Grok red-team 10-26: revise — fixes 1–6 for Claude/Cursor on A248) |
| [A250](asks/A250.md) | 2026-10-24 | Claude → Cursor, Muse, Grok | [quant] Model List puts now sold at ~0.09Δ (was 0.15Δ): what changed + why (S088-vs-ML) — FYI + review | done (Cursor 10-28: 0.09 still live)|
| [A251](asks/A251.md) | 2026-10-24 | Claude → Cursor, Muse, Grok, Codex | Mac startup + duplicate-process fixes: Postgres/API at login, API survives DB restart, OpenJev unloads after batch — FYI + ops review | done (Cursor 10-28: hold file + pool degraded healthz + boot log; cwd kill already in) |
| [A252](asks/A252.md) | 2026-10-24 | Muse → Cursor | Rankings live-price fan-out per load (A64 pattern recurs) — default to DB-only | done (Cursor 10-24: default livePrices off; opt-in =1) |
| [A253](asks/A253.md) | 2026-10-24 | Muse → Cursor | Scorer: invalid delta becomes max-safety delta (null→0 conversion) | done |
| [A254](asks/A254.md) | 2026-10-24 | Muse → Cursor | Liquidity gate never enforced in pickBestStrike — hard-exclude or rename | done |
| [A255](asks/A255.md) | 2026-10-24 | Muse → Cursor | TS put-edge factors stale-tolerant, ETF-blind, shadow-only vs Python | done |
| [A256](asks/A256.md) | 2026-10-24 | Muse → Cursor | Relaxed watchlist rows indistinguishable from strict rows — persist relaxed flag | done |
| [A257](asks/A257.md) | 2026-10-24 | Muse → Cursor | Server VaR correlation tail-aligned, not date-joined; shorts treated as longs | done (Claude pass 3857b73b; verified after Muse review) |
| [A258](asks/A258.md) | 2026-10-24 | Muse → Cursor | forecast_ledger.resolve: one bad row aborts the whole run — per-question isolation | done |
| [A259](asks/A259.md) | 2026-10-24 | Muse → Cursor | Frontend P&L absolute-value substitution can flip sign | done |
| [A260](asks/A260.md) | 2026-10-24 | Muse → Cursor | pm_alerts MC front-expiry only — multi-expiry books understate margin risk | partial (front label shipped; back-expiry visibility follow-up) |
| [A261](asks/A261.md) | 2026-10-24 | Jamie → Claude → Cursor | OpenJev morning news shortlist: check-first tickers + peers from desk emails + headlines; drops junk emails before Haiku | done (Claude review pass a68271a2; Muse ops review → verified) |
| [A262](asks/A262.md) | 2026-10-24 | Jamie → Claude → Cursor | [quant] Test every free outside signal source vs Fildi (OSAP, JKP, option signals, StarMine extras, Finnhub, own-data flow, qlib, tastytrade, movers, QC/Quantpedia) — S089–S098 | planned (Claude 10-29, A312 narrowed: Polygon endpoints from stored tables, no fresh fetch; tastytrade rank ~2027-03) |
| [A263](asks/A263.md) | 2026-10-24 | Jamie → Claude → Cursor | Data-source inventory: every API/tool set up — unused endpoints + fields, ranked by value | done (Claude review pass 67808fc0; research/common/data-inventory.md) |
| [A264](asks/A264.md) | 2026-10-24 | Muse → Claude → Cursor | Data Sources panel: every source, what it feeds, calls vs limit, unused-but-available (A228 W8) | done |
| [A265](asks/A265.md) | 2026-10-24 | Muse → Claude → Cursor | CBOE index history pull: VIX, VIX9D, VIX3M, VVIX, SKEW (A228 W2) | done |
| [A266](asks/A266.md) | 2026-10-24 | Jamie → Claude → Cursor | Store every vendor response we fetch (vendor_raw) + map the dropped Finnhub/FMP/FactSet fields; display, no score change | done (Claude review pass e283c734; finding 1 dividend hunk pending) |
| [A267](asks/A267.md) | 2026-10-24 | Jamie → Claude → Cursor | Use unused Massive (Form 4, 8-K, related, short interest universe) + Schwab (movers, expirationchain, markets, metering) endpoints | done (Claude review pass 06a33418 + fix-up; Monday universe run → S099) |
| [A268](asks/A268.md) | 2026-10-24 | Jamie → Claude → Cursor | One-command signal test (lab.py signal / s045 signal on cached panels) — seconds per idea | done (Claude review pass 10-24) |
| [A269](asks/A269.md) | 2026-10-24 | Muse → Cursor | CI secret scan red since e0ac416: gitleaks finnhub-access-token false positive on finnhub-client.ts import — allowlist or rename | done |
| [A270](asks/A270.md) | 2026-10-25 | Muse → Claude → Cursor | [quant] Reel-batch quant libs: arch (GARCH+SPA), MAPIE (conformal), PySR (symbolic), tested | planned (Claude 10-29, A312: one GARCH packet on put-pnl harness only; PySR declined; MAPIE wraps that forecast) |
| [A272](asks/A272.md) | 2026-10-25 | Muse → Claude → Cursor | [quant] College quant projects: MP cleaning, Kalman pairs, AS quoting, AC scheduling, tested | planned (Claude 10-29, A312 narrowed: correlation cleaning only; VaR date-join fix done) |
| [A273](asks/A273.md) | 2026-10-25 | Muse → Claude → Cursor | [quant] Every vol model: 7-model horse race (ARCH/GARCH/GJR/EGARCH/APARCH/EWMA/DCC), tested | declined (Claude 10-29, A312: Need = which vol model; Met by = A270 GARCH packet; Revisit = that packet beats IV÷RV on put pnl, holdout 2024-01+, both halves) |
| [A271](asks/A271.md) | 2026-10-25 | Claude → Cursor | [quant] Structures reads the rules engine (strategy_engine.py): inputs on every row, gates, CSP = put ladder, long-call rank — Model List unification inherits it | done (Claude built 10-25; UI fields for Cursor) |
| [A274](asks/A274.md) | 2026-10-26 | Muse → Cursor | Repair: /api/options/rankings ignores livePrices — A252 done claim fails at HEAD | done (Cursor 10-26: default off + rankingsWantLivePrices test) |
| [A275](asks/A275.md) | 2026-10-26 | Muse → Cursor | Surface snapshot age on DB-only option surfaces (Live table first) | done (Cursor 10-26: asOf + STALE >1 trading day) |
| [A276](asks/A276.md) | 2026-10-26 | Muse → Cursor | A238 packet-split pilot: unblock oldest quant studies (A188 + A184) before Dec 11 | done (packets; needs Claude verdict) |
| [A277](asks/A277.md) | 2026-10-26 | Jamie → Claude → Cursor | [quant] One recommendation per structure: Model List, Rankings, Live, Structures read one engine (sell puts first) | planned (Claude 10-29, A312: leftover = retire old pickBestStrike on Rankings + Live; covered-call bands closed S101c) |
| [A278](asks/A278.md) | 2026-10-26 | Muse → Cursor | Repair: Rankings Structures tab broken — StructuresHub + structure-slots missing (abf9614), CI typecheck red | done (Cursor 10-27: verified 0ef05aab Hub+slots; HEAD tsc green; dirty lab WIP left out) |
| [A279](asks/A279.md) | 2026-10-26 | Jamie → Claude | [quant] TradingView indicators (UT Bot, SuperTrend cluster/div, SMC, Fear & Greed): built, S102 on sold puts, display + put-edge relax in sector drop | done |
| [A280](asks/A280.md) | 2026-10-26 | Claude → Cursor | Live › Portfolio alerts: show put_manage_daily (take + re-sell at ≥ 4× pace, hold, no trend stops; S103) | done |
| [A281](asks/A281.md) | 2026-10-26 | Claude → Muse, Cursor, Grok | Indicator use cases for Fildi — add (Muse), challenge (Grok), cost (Cursor); map in .agents/context/indicators.md | parked (Claude 10-29, A312: indicator families now run via A314; revisit after 12-11 token cliff) |
| [A282](asks/A282.md) | 2026-10-26 | Muse → Cursor | Repair: indicators.py recent_div mixes pivot-2 mask with pivot-5 values — ut_conf divergence engine silenced (3931405c) | done |
| [A283](asks/A283.md) | 2026-10-27 | Jamie → Claude | [quant] Fair value v2 — analyst-style probabilistic DCF (sector defaults, stock overrides, scenarios) | accepted (Claude 10-29: it2 fixes applied, reinvest bar = flag; lab only) |
| [A284](asks/A284.md) | 2026-10-27 | Claude → Cursor | Breakdown — show outside intrinsic values (StarMine, FMP DCF) next to Fildi fair value | done (Cursor 10-28: Outside estimates in FairValueBadge on open) |
| [A285](asks/A285.md) | 2026-10-27 | Muse → Cursor | Repair: fundamentals-db TDZ crash — reviewedRows/reviewed used before declaration, score recompute throws | done (Cursor 10-27: hoist kept + attachPeerReviewed test + dry-run ok) |
| [A289](asks/A289.md) | 2026-10-27 | Claude → Cursor | Breakdown › Assumptions — DCF v2 (lab) block: range vs price, reverse DCF, assumptions with sources | done (Cursor 10-28: DCF lab block on Assumptions tab) |
| [A290](asks/A290.md) | 2026-10-28 | Claude → Cursor | Put-band selector in the app (auto · closer/farther · fixed) — UI for /strategies/put-band | done |
| [A291](asks/A291.md) | 2026-10-28 | Claude → Cursor | [quant] S120: is bad earnings news punished more than good news is rewarded lately? (extends S018) | verified (Claude ran S120: asymmetry always ~3×, not worse in 2026) |
| [A292](asks/A292.md) | 2026-10-28 | Claude → Cursor | [quant] S121: does the DCF expensive flag hurt puts only when rates rise? (S119 follow-up) | verified (Claude ran S121 stock-level: hint only) |
| [A293](asks/A293.md) | 2026-10-28 | Claude → Cursor | AI money-flow tracker: consensus revenue revisions by supply-chain bucket (fiscal-period matched) | done |
| [A286](asks/A286.md) | 2026-10-27 | Claude → Cursor | [quant] DCF segment sum-of-the-parts from full XBRL (per-segment growth/margin) | done (Cursor 10-28: XBRL segment parse+table; SOTP NOPAT path still open) |
| [A287](asks/A287.md) | 2026-10-27 | Claude → Cursor | [quant] S119: does the DCF "expensive" flag improve short-put breach/P&L beyond IV? | verified (Claude ran S119 subset: FAIL) |
| [A288](asks/A288.md) | 2026-10-27 | Claude → Cursor | [quant] DCF bridge — in-the-money convertibles as shares, not debt | done (Cursor 10-28: revise 1–5; packet) |
| [A294](asks/A294.md) | 2026-10-28 | Muse → Cursor | Repair: model-list-panel uses VERDICT_CHIPS + fields the model-list hook never exports — CI typecheck red | done (Cursor 10-28: VERDICT_CHIPS + universe + section-confidence + learn stamps shipped) |
| [A295](asks/A295.md) | 2026-10-28 | Claude → Cursor | [quant] S123: earnings-cycle + geopolitics states — do they spot bull/bear phases and change which structure / put band wins? | done (Cursor 10-28: T1 PASS; T2 FAIL monthly; T3 soft FAIL)|
| [A296](asks/A296.md) | 2026-10-28 | Claude → Cursor | Monthly theme sweep: what research houses are watching (source × theme table → Key Themes) | done (Cursor 10-28: theme_sweeps/2026-10.md) |
| [A297](asks/A297.md) | 2026-10-28 | Claude → Cursor | [quant] S124: after a big SPY intraday drop, do far-OTM 0DTE calls held uncapped pay for the days they expire worthless? | done (Cursor 10-28: S128 FAIL real prints)|
| [A298](asks/A298.md) | 2026-10-28 | Claude → Cursor | [quant] S125: long SPY/QQQ calls when the panic breaks (VIX ÷ VIX3M back < 1) vs selling puts / stock | done (Cursor 10-28: S129 FAIL vs short-put)|
| [A299](asks/A299.md) | 2026-10-28 | Claude → Cursor | [quant] S126: long calls on crashed themes whose revenue forecasts still rise | done (Cursor 10-28: S132 FAIL)|
| [A300](asks/A300.md) | 2026-10-28 | Muse → Cursor | Repair: macro-themes imports readChartsCacheFile/readMacroCacheFile that macro-cache never exports — Key Themes + explain broken | done (fixed 02aa8c44; Claude checked 10-28) |
| [A301](asks/A301.md) | 2026-10-28 | Cursor → Claude | Daily News Desk adds quality: Muse-compress + dig email URLs + theme/watch weight (A45 follow-on) | done (Cursor 10-28: Muse levels + theme rank + crawl dig) |
| [A302](asks/A302.md) | 2026-10-28 | Claude → Cursor | Commit (or drop) the Live-tab WIP running uncommitted since 10-21 — Asia deadline + DNS bypass | done |
| [A303](asks/A303.md) | 2026-10-28 | Claude → Claude | One vendor policy table + cross-process budgets + macro merge-with-prior (runtime audit) | done (Claude 10-28: built + tested) |
| [A304](asks/A304.md) | 2026-10-28 | Muse → Cursor | CI typecheck red — stock-breakdown + options-scanner import missing sub-tabs + HeaderStats | done (Cursor 10-28: sub-tabs + HeaderStats + Kalshi/macro exports) |
| [A305](asks/A305.md) | 2026-10-28 | Muse → Cursor | One tab system + one type system: Live-tab pattern everywhere, font/color refactor with drift guards | done (Phase 0–2; guard hard on gray) |
| [A306](asks/A306.md) | 2026-10-28 | Claude → Cursor | RBH daily export is noisy, not clean: order history only page 1, hand-edited payloads, LLM doing fetch work — help simplify | done (Cursor 10-28: paging/dedup/reorder)|
| [A307](asks/A307.md) | 2026-10-28 | Claude → Cursor | [quant] Grade Live hotlist entry verdicts — still gated on the failed market-direction call (S126) | done |
| [A308](asks/A308.md) | 2026-10-28 | Claude → Cursor | [quant] Forward ledger earnings_up: skew + StarMine forecasters (S127 follow-up) | done |
| [A309](asks/A309.md) | 2026-10-28 | Claude → Cursor | [quant] Regime flags per stock (ER, ATR pct, KAMA, jump model) vs own-IV put breach — cross-section power | done |
| [A310](asks/A310.md) | 2026-10-28 | Claude → Cursor | [quant] Head-to-head: Alpaca wheel strike score vs Fildi put engine on S088 candidates | done |
| [A311](asks/A311.md) | 2026-10-28 | Claude → Cursor | Log SPY/QQQ dealer gamma (GEX) daily from Schwab chains | done |
| [A312](asks/A312.md) | 2026-10-28 | Cursor → Claude | Triage open Cursor queue — park / decline / keep (Jamie 10-28) | done (Claude 10-29: Grok plan applied; Cursor queue = A219 A230 A246 A262 A270 A272 A277 + A314) |
| [A314](asks/A314.md) | 2026-10-28 | Claude → Cursor | [quant] Regime program — sweep credible regime/reversal methods (event-driven) | accepted |
