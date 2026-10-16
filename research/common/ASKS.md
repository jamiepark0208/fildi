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
| [A38](asks/A38.md) | 2026-10-07 | Cursor → Muse | Standing: monitor app runs smoothly | open |
| [A1](asks/A1.md) | 2026-10-04 | Claude → Cursor | API Monitor: `SOURCE_META` + `PRIMARY_SOURCES` for `lseg` (10k/day) and `wrds`; WRDS `api_usage` metering | done |
| [A2](asks/A2.md) | 2026-10-04 | Claude → Cursor | Scheduled Tasks: supervised entries for LSEG daily/weekly, WRDS monthly/quarterly; `rbh-ingest` copy (no … | accepted |
| [A3](asks/A3.md) | 2026-10-04 | Claude → Cursor | Stock DB: "Vendor cross-check" panel reading `GET /api/research/lseg/audit` | open |
| [A4](asks/A4.md) | 2026-10-04 | Claude → Cursor | research-ops.ts: add earnings_moves / holders_top / coverage / gold_audit thresholds; security_map_ids 14d → … | open |
| [A5](asks/A5.md) | 2026-10-04 | Claude → Cursor | Scorecard Guide: document IBES growth extras; StarMine display-only | open |
| [A6](asks/A6.md) | 2026-10-04 | Claude → Cursor | WRDS `purge.py` (license deletion) | open |
| [A7](asks/A7.md) | 2026-10-04 | Claude → Cursor | Bug: model_recs stale spot (prior-day close used as spot) | done |
| [A8](asks/A8.md) | 2026-10-04 | Claude → Cursor | Premium realism: grade at realistic fill, spread/OI gates | accepted |
| [A10](asks/A10.md) | 2026-10-04 | Claude → Cursor | IV quality: Yahoo nearest-expiry IV unfit for premium ranking | accepted |
| [A14](asks/A14.md) | 2026-10-05 | Claude → Cursor | Coordination: you're adding `fund_score_snapshots` / `fund_score_notes` (accountability). Claude is planning … | accepted |
| [A16](asks/A16.md) | 2026-10-05 | Claude → Cursor | Splits are never back-adjusted in prices_historical | accepted |
| [A17](asks/A17.md) | 2026-10-05 | Claude → Cursor | Step 6 learning loop is live for Claude's layer | accepted |
| [A20](asks/A20.md) | 2026-10-05 | Cursor → Claude | A19 progress | open |
| [A22](asks/A22.md) | 2026-10-05 | Cursor → Claude | Data-ops notes from user Qs | open |
| [A24](asks/A24.md) | 2026-10-05 | Cursor → Claude | Your lane: RH trade tiers → learning loop | accepted |
| [A25](asks/A25.md) | 2026-10-05 | Claude → Cursor | Scorecard lab results + proposed scorecard changes | partial |
| [A45](asks/A45.md) | 2026-10-08 | Muse → Cursor | Daily News: brief-first pipeline + materiality gate | done |
| [A47](asks/A47.md) | 2026-10-10 | Muse → Cursor | [quant] Recommendation survival rule (Model List quarantine) | declined (Claude 10-14: wrong in principle; S015 no effect) |
| [A49](asks/A49.md) | 2026-10-10 | Muse → Cursor | [quant] Continuous event-risk engine (all macro events) | planned (plan review: A59) |
| [A50](asks/A50.md) | 2026-10-10 | Muse → Cursor | Event-risk UI + alerting (materiality-gated) | done (Claude 10-14: Live › Portfolio Alerts) |
| [A51](asks/A51.md) | 2026-10-10 | Muse → Cursor | [quant] Scorer event-risk gate spec (penalty/block) | declined gate; earnings need → A79 + S018 (Claude audit 10-15: old reason ignored S003) |
| [A52](asks/A52.md) | 2026-10-10 | Muse → Cursor | [quant] Proprietary FCF model + per-stock characteristic learning | planned (plan review: A59) |
| [A53](asks/A53.md) | 2026-10-10 | Muse → Cursor | [quant] IV surface pipeline (port volsurface + pysvi, MIT) | planned (plan review: A59) |
| [A54](asks/A54.md) | 2026-10-10 | Muse → Cursor | [quant] Greeks/IV math library (port marketcalls/opengreeks, MIT) | planned (plan review: A59) |
| [A55](asks/A55.md) | 2026-10-10 | Muse → Cursor | [quant] Algorithmic S/R detection (port Price-Action-Engine, MIT) | planned (plan review: A59) |
| [A56](asks/A56.md) | 2026-10-10 | Muse → Cursor | [quant] Characteristic feature seed (qlib Alpha158 + ta, MIT) + HMM regimes | planned (plan review: A59) |
| [A57](asks/A57.md) | 2026-10-10 | Muse → Cursor | [quant] Vectorized backtest harness (vectorbt design — license TBD) | declined (Claude 10-14: backtest_puts.py is the home) |
| [A62](asks/A62.md) | 2026-10-11 | Muse → Cursor | Brief staleness guard (A45 gap) | done |
| [A63](asks/A63.md) | 2026-10-11 | Muse → Cursor | [quant] Source-ranked upsert for price bars | planned (Claude plan 10-14) |
| [A65](asks/A65.md) | 2026-10-11 | Muse → Cursor | Stop ingesting on every Daily News poll | done |
| [A66](asks/A66.md) | 2026-10-12 | Muse → Cursor | Repair A62 row collision — staleness-guard spec was overwritten | done |
| [A67](asks/A67.md) | 2026-10-12 | Muse → Cursor | Run the A51 event-window study before CPI (Oct 14) | deferred (CPI passed; run only if A51 wanted) |
| [A68](asks/A68.md) | 2026-10-12 | Muse → Cursor | Position ingestion for the options-book brief (upload-first adapters) | declined (exists: RH importer + pm_book; Claude plan 10-14) |
| [A70](asks/A70.md) | 2026-10-12 | Muse → Cursor | Dead materiality branch in Daily News GET (brief-change check never fires) | done |
| [A71](asks/A71.md) | 2026-10-12 | Cursor → Muse | Plan triage: confirm defer/decline on low-value Muse rows | done |
| [A72](asks/A72.md) | 2026-10-12 | Muse → Cursor | Fildi live-server migration — private always-on app (phased, iterative) | planned v3 (Claude 10-14: Oracle free + laptop pushes LSEG/RH; no hardware) |
| [A73](asks/A73.md) | 2026-10-14 | Muse → Cursor | Schwab auth resilience: 7-day lifecycle manager, one-click re-auth, loud outage alerts | done |
| [A74](asks/A74.md) | 2026-10-14 | Muse → Cursor | [quant] Probabilistic decision frameworks: component migration plan | planned, narrowed (Claude 10-14: calibration logging only) |
| [A75](asks/A75.md) | 2026-10-14 | Muse → Cursor | Data source & feature utilization: API audit, UX gaps, server-mode ops | planned v3 (Claude 10-14: expiry + short interest + transcripts done; rest parked) |
| [A76](asks/A76.md) | 2026-10-14 | Claude → Cursor | PM surfaces: Book card, Expiry desk (what-if), Alert center | done |
| [A77](asks/A77.md) | 2026-10-14 | Muse → Cursor | pm_book: NULL spot on new tickers crashes book + alert loop | done |
| [A78](asks/A78.md) | 2026-10-14 | Muse → Cursor | S015 trade_mistakes.py: broken street_scenarios import (analysis/) | done |
| [A79](asks/A79.md) | 2026-10-14 | Muse → Cursor | Earnings risk score on the calendar (pre-earnings blowup flag) | planned, narrowed (Claude 10-14: strike vs own earnings moves; study first) |
| [A80](asks/A80.md) | 2026-10-14 | Muse → Cursor | Thesis tracker (morning call vs evening outcome, scored) | declined (Claude 10-14: changes no trade) |
| [A81](asks/A81.md) | 2026-10-14 | Muse → Cursor | Put-seller 'so what' in the options scanner | planned, narrowed (Claude 10-14: facts now, takes after study) |
| [A82](asks/A82.md) | 2026-10-14 | Muse → Cursor | [quant] Prediction-markets data integration (Polymarket + Kalshi) | planned, minimal (Claude 10-14: display odds only) |
| [A83](asks/A83.md) | 2026-10-14 | Muse → Cursor | Code refactor: dedup, structure, AI-safe optimizations | planned (Claude 10-14) |
| [A84](asks/A84.md) | 2026-10-14 | Claude → Cursor | Data-client bugs from endpoint probe (dead Polygon call, FMP waste, AV key name) | accepted (Claude decided 10-15: polygon last-resort, before/after must show ~0) |
| [A85](asks/A85.md) | 2026-10-14 | Muse → Cursor | [quant] Figure & macro-view tracker for the macro tab (personal Dub) | planned, narrowed (Claude 10-14: ~10 scoreable figures, CI shown) |
| [A86](asks/A86.md) | 2026-10-14 | Muse → Cursor | [quant] Fair-value disagreement lab (chart vs street, divergence monitor, assumption back-out) | planned, narrowed (Claude 10-14) |
| [A87](asks/A87.md) | 2026-10-14 | Claude → Cursor | 12 tickers with no price rows (BRK.B/BF.B/BK + delisted) → no fair value | open |
| [A88](asks/A88.md) | 2026-10-14 | Muse → Cursor | Agent mission control: Jira-like tracking for agent work | planned, narrowed (Claude 10-14: read-only board + Needs Jamie lane) |
| [A89](asks/A89.md) | 2026-10-14 | Muse → Cursor | [quant] Offline evolutionary strategy lab (never live agents on PnL) | declined (Claude 10-14: sample too small; data-snooping) |
| [A90](asks/A90.md) | 2026-10-14 | Muse → Cursor | Sector-specialist reader agents (parallel readers + committee) | declined (Claude 10-14: no decision needs it; parts → A95) |
| [A91](asks/A91.md) | 2026-10-14 | Muse → Cursor | Global money-flow tracker (entities, orbs, Sankey) | declined (Jamie 10-15: not needed; ETF holdings change view A98 instead) |
| [A92](asks/A92.md) | 2026-10-14 | Muse → Cursor | [quant] Assignment-aware track record (2-week exit rule + per-stock drill-down) | planned (Claude 10-14: day-10 close exit, not hindsight max) |
| [A93](asks/A93.md) | 2026-10-14 | Muse → Cursor | TradingView-class chart (fix zoom, indicators, signals, IV band) | planned (Phase 1 zoom done; IV band next) |
| [A94](asks/A94.md) | 2026-10-14 | Muse → Cursor | Conviction ledger (structured theses, evidence, kill criteria) | planned, narrowed (Claude 10-14: held names, checkable kill rules) |
| [A95](asks/A95.md) | 2026-10-14 | Muse → Cursor | Analyst revision breadth: sector upgrade/downgrade timeline | planned (Claude 10-14: LSEG revision breadth, not just ratings) |
| [A96](asks/A96.md) | 2026-10-14 | Claude → Cursor | Polygon cheap extras: market breadth, price gaps, ex-div warnings, short volume | open |
| [A113](asks/A113.md) | 2026-10-14 | Claude → Cursor | Holdings review: MP fair value, GOSS target, ADBE cohort errors | open |
| [A114](asks/A114.md) | 2026-10-15 | Claude → Cursor | earnings_calendar stores fiscal period ends as report dates (half of past rows) | open |
| [A97](asks/A97.md) | 2026-10-14 | Muse → Cursor | Fill analyst Tgt column from archived FMP titles + email pipeline | planned, rewritten (Claude 10-15: Yahoo already sends targets; parser drops them) |
| [A98](asks/A98.md) | 2026-10-14 | Muse → Cursor | ETF holdings-change tracker (what ETFs are buying/selling) | planned, re-scoped (Claude 10-15: fund flows from NAV files, not holdings diffs) · Jamie 10-15: wanted, P2 |
| [A99](asks/A99.md) | 2026-10-14 | Muse → Cursor | Data confidence: source, freshness, quality per number | planned, narrowed (Claude 10-15: show provenance; no 0–100 score) |
| [A100](asks/A100.md) | 2026-10-14 | Muse → Cursor | Free compute sweep backend (Colab/Kaggle for backtest sweeps) | declined (Claude 10-15: compute isn't the bottleneck) |
| [A101](asks/A101.md) | 2026-10-14 | Muse → Cursor | Easy-win scanner: laggards, reversals, vol mispricings | planned, narrowed (Claude 10-15: 2 of 4 phases already built; laggard = study first) |
| [A102](asks/A102.md) | 2026-10-14 | Muse → Cursor | Periodic extreme-score review (outlier QA for score models) | planned, narrowed (Claude 10-15: weekly outlier list; probe found 12 now) |
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
| [A115](asks/A115.md) | 2026-10-15 | Muse → Cursor | Trend-efficiency regime filter for premium selling | open |
| [A116](asks/A116.md) | 2026-10-15 | Muse → Cursor | Agent-tooling roundup: adopt the good skills, vet the rest | open |
| [A117](asks/A117.md) | 2026-10-15 | Muse → Cursor | Backend quant-algorithm inventory: map the classics to fildi gaps | open |
| [A118](asks/A118.md) | 2026-10-15 | Muse → Cursor | Extended agent-tooling evaluation (archify, trail of bits, spec kit, taskmaster, serena) | open |
| [A119](asks/A119.md) | 2026-10-15 | Muse → Cursor | Personal AI agent landscape: free-tier use cases (hermes, openclaw, grokbot, dots, instinct) | open |
| [A120](asks/A120.md) | 2026-10-15 | Muse → Claude | Pattern-discovery research program: regimes, reversals, calendar, lead-lag, automated X/Y engine | open |
| [A121](asks/A121.md) | 2026-10-15 | Muse → Cursor | scoreboard.py: exception path rolls back DDL + all earlier checks, then crashes | open |
| [A122](asks/A122.md) | 2026-10-15 | Muse → Cursor | Muse live status on the Stage orb grid (git heartbeat) | open |
| [A123](asks/A123.md) | 2026-10-15 | Muse → Cursor | Crawl4AI + Browser Use pilot (tested before filing) | open |
| [A124](asks/A124.md) | 2026-10-16 | Muse → Cursor | Pythia forecasting-oracle pilot (tested before filing) | open |
