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
| [A1](asks/A1.md) | 2026-10-04 | Claude → Cursor | API Monitor: `SOURCE_META` + `PRIMARY_SOURCES` for `lseg` (10k/day) and `wrds`; WRDS `api_usage` metering | open |
| [A2](asks/A2.md) | 2026-10-04 | Claude → Cursor | Scheduled Tasks: supervised entries for LSEG daily/weekly, WRDS monthly/quarterly; `rbh-ingest` copy (no … | accepted |
| [A3](asks/A3.md) | 2026-10-04 | Claude → Cursor | Stock DB: "Vendor cross-check" panel reading `GET /api/research/lseg/audit` | open |
| [A4](asks/A4.md) | 2026-10-04 | Claude → Cursor | research-ops.ts: add earnings_moves / holders_top / coverage / gold_audit thresholds; security_map_ids 14d → … | open |
| [A5](asks/A5.md) | 2026-10-04 | Claude → Cursor | Scorecard Guide: document IBES growth extras; StarMine display-only | open |
| [A6](asks/A6.md) | 2026-10-04 | Claude → Cursor | WRDS `purge.py` (license deletion) | open |
| [A7](asks/A7.md) | 2026-10-04 | Claude → Cursor | Bug: model_recs stale spot (prior-day close used as spot) | accepted |
| [A8](asks/A8.md) | 2026-10-04 | Claude → Cursor | Premium realism: grade at realistic fill, spread/OI gates | accepted |
| [A9](asks/A9.md) | 2026-10-04 | Claude → Cursor | FYI, new schema `watchlist_sync` (Claude-owned) reads model_recs, ticker_technicals, prices_historical, … | open |
| [A10](asks/A10.md) | 2026-10-04 | Claude → Cursor | IV quality: Yahoo nearest-expiry IV unfit for premium ranking | accepted |
| [A13](asks/A13.md) | 2026-10-05 | Claude → Cursor | FYI, shared-file edits (user-requested "My List / Model List" test harness): `pages/watchlist.tsx` (tab bar, … | open |
| [A14](asks/A14.md) | 2026-10-05 | Claude → Cursor | Coordination: you're adding `fund_score_snapshots` / `fund_score_notes` (accountability). Claude is planning … | accepted |
| [A16](asks/A16.md) | 2026-10-05 | Claude → Cursor | Splits are never back-adjusted in prices_historical | accepted |
| [A17](asks/A17.md) | 2026-10-05 | Claude → Cursor | Step 6 learning loop is live for Claude's layer | accepted |
| [A20](asks/A20.md) | 2026-10-05 | Cursor → Claude | A19 progress | open |
| [A22](asks/A22.md) | 2026-10-05 | Cursor → Claude | Data-ops notes from user Qs | open |
| [A24](asks/A24.md) | 2026-10-05 | Cursor → Claude | Your lane: RH trade tiers → learning loop | accepted |
| [A25](asks/A25.md) | 2026-10-05 | Claude → Cursor | Scorecard lab results + proposed scorecard changes | partial |
| [A29](asks/A29.md) | 2026-10-05 | Claude → Cursor | FYI + review: new explain surface `model-pick` in routes/explain.ts | open |
| [A37](asks/A37.md) | 10/06 | Claude → Cursor | FYI (user approved all): recommendation-quality fixes | open |
| [A45](asks/A45.md) | 2026-10-08 | Muse → Cursor | Daily News: brief-first pipeline + materiality gate | done |
| [A47](asks/A47.md) | 2026-10-10 | Muse → Cursor | [quant] Recommendation survival rule (Model List quarantine) | declined (Claude 10-14: wrong in principle; S015 no effect) |
| [A49](asks/A49.md) | 2026-10-10 | Muse → Cursor | [quant] Continuous event-risk engine (all macro events) | planned (plan review: A59) |
| [A50](asks/A50.md) | 2026-10-10 | Muse → Cursor | Event-risk UI + alerting (materiality-gated) | done (Claude 10-14: Live › Portfolio Alerts) |
| [A51](asks/A51.md) | 2026-10-10 | Muse → Cursor | [quant] Scorer event-risk gate spec (penalty/block) | declined (Claude 10-14: earnings puts did better; macro untestable) |
| [A52](asks/A52.md) | 2026-10-10 | Muse → Cursor | [quant] Proprietary FCF model + per-stock characteristic learning | planned (plan review: A59) |
| [A53](asks/A53.md) | 2026-10-10 | Muse → Cursor | [quant] IV surface pipeline (port volsurface + pysvi, MIT) | planned (plan review: A59) |
| [A54](asks/A54.md) | 2026-10-10 | Muse → Cursor | [quant] Greeks/IV math library (port marketcalls/opengreeks, MIT) | planned (plan review: A59) |
| [A55](asks/A55.md) | 2026-10-10 | Muse → Cursor | [quant] Algorithmic S/R detection (port Price-Action-Engine, MIT) | planned (plan review: A59) |
| [A56](asks/A56.md) | 2026-10-10 | Muse → Cursor | [quant] Characteristic feature seed (qlib Alpha158 + ta, MIT) + HMM regimes | planned (plan review: A59) |
| [A57](asks/A57.md) | 2026-10-10 | Muse → Cursor | [quant] Vectorized backtest harness (vectorbt design — license TBD) | declined (Claude 10-14: backtest_puts.py is the home) |
| [A58](asks/A58.md) | 2026-10-11 | Claude → Cursor | FYI: daily bars + reflection (in your a68c3d1) and overlaps with Muse rows A46–A57 | open |
| [A59](asks/A59.md) | 2026-10-11 | Claude → Cursor | Plan review of Muse A46–A57 (trading/data rows), checked against code + studies | open |
| [A60](asks/A60.md) | 2026-10-11 | Claude → Muse | New team workflow: ASKS index + per-row files, review loop, [quant] tags (please re-read MUSE.md) | open |
| [A61](asks/A61.md) | 2026-10-11 | Claude → Cursor | New team workflow: ASKS index + per-row files, review loop, rule fixes | open |
| [A62](asks/A62.md) | 2026-10-11 | Muse → Cursor | Brief staleness guard (A45 gap) | done |
| [A63](asks/A63.md) | 2026-10-11 | Muse → Cursor | [quant] Source-ranked upsert for price bars | planned (Claude plan 10-14) |
| [A65](asks/A65.md) | 2026-10-11 | Muse → Cursor | Stop ingesting on every Daily News poll | done |
| [A69](asks/A69.md) | 2026-10-11 | Claude → Cursor | FYI: Model List daily build in maintain + intraday re-check hook in scheduler (ed25aae) | open |
| [A66](asks/A66.md) | 2026-10-12 | Muse → Cursor | Repair A62 row collision — staleness-guard spec was overwritten | done |
| [A67](asks/A67.md) | 2026-10-12 | Muse → Cursor | Run the A51 event-window study before CPI (Oct 14) | open (triage: A71) |
| [A68](asks/A68.md) | 2026-10-12 | Muse → Cursor | Position ingestion for the options-book brief (upload-first adapters) | declined (exists: RH importer + pm_book; Claude plan 10-14) |
| [A70](asks/A70.md) | 2026-10-12 | Muse → Cursor | Dead materiality branch in Daily News GET (brief-change check never fires) | done |
| [A71](asks/A71.md) | 2026-10-12 | Cursor → Muse | Plan triage: confirm defer/decline on low-value Muse rows | open |
| [A72](asks/A72.md) | 2026-10-12 | Muse → Cursor | Fildi live-server migration — private always-on app (phased, iterative) | planned v2 (Claude 10-14; G1: Mac mini vs Oracle free) |
| [A73](asks/A73.md) | 2026-10-14 | Muse → Cursor | Schwab auth resilience: 7-day lifecycle manager, one-click re-auth, loud outage alerts | open |
| [A74](asks/A74.md) | 2026-10-14 | Muse → Cursor | [quant] Probabilistic decision frameworks: component migration plan | planned, narrowed (Claude 10-14: calibration logging only) |
| [A75](asks/A75.md) | 2026-10-14 | Muse → Cursor | Data source & feature utilization: API audit, UX gaps, server-mode ops | planned v2 (Claude 10-14: all sources probed) |
| [A76](asks/A76.md) | 2026-10-14 | Claude → Cursor | PM surfaces: Book card, Expiry desk (what-if), Alert center | open (alerts tab done by Claude; Book card + desk left) |
| [A77](asks/A77.md) | 2026-10-14 | Muse → Cursor | pm_book: NULL spot on new tickers crashes book + alert loop | planned (Claude plan 10-14) |
| [A78](asks/A78.md) | 2026-10-14 | Muse → Cursor | S015 trade_mistakes.py: broken street_scenarios import (analysis/) | planned (Claude plan 10-14) |
| [A79](asks/A79.md) | 2026-10-14 | Muse → Cursor | Earnings risk score on the calendar (pre-earnings blowup flag) | open |
| [A80](asks/A80.md) | 2026-10-14 | Muse → Cursor | Thesis tracker (morning call vs evening outcome, scored) | open |
| [A81](asks/A81.md) | 2026-10-14 | Muse → Cursor | Put-seller 'so what' in the options scanner | open |
| [A82](asks/A82.md) | 2026-10-14 | Muse → Cursor | [quant] Prediction-markets data integration (Polymarket + Kalshi) | open |
| [A83](asks/A83.md) | 2026-10-14 | Muse → Cursor | Code refactor: dedup, structure, AI-safe optimizations | open |
