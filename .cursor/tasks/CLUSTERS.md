# Task Clusters — build groupings (updated 2026-07-11)

Tasks grouped by dependency / logical cohesion. Check `INDEX.md` for current bug status.

---

## Completed

**Bugs (bugs/1–19)** — all done or intentionally rejected. Per-task detail in `INDEX.md`'s bugs table, not duplicated here. Note: bug/19 was implemented, verified, then reverted at explicit user direction (no shared-watchlist seeding on register) — don't re-file as-is, see the task file's DONE note.

**enh/34 performance-resilience-optimization** — done 2026-07-11 (Waves A–D): route error boundaries, lazy routes + `PageSkeleton` + unified query-keys + idle chunk-prefetch, `tsx watch` dev server, `scripts/dev-up.sh`. Wave C was already covered by bugs 4/5/11/12 (skipped, not double-implemented). Full notes in the task file.

**enh/5 api-dev-hot-reload** — done 2026-07-11, folded into enh/34 Wave D (same `tsx watch` change). Don't re-file separately.

**Cluster 1 — CI / Test + Observability**
- enh/3 ci-pipeline, enh/4 api-integration-test-harness, enh/7 observability-error-tracking — all done.

**Cluster 3 — Score explanations + AI narration**
- naf/3 contextual-score-explanations — done 2026-07-10 (ExplainableScore, useScoreExplanation, explain_cache table, both leaderboards refactored).
- ai/11 product-ai-explain-csp — unblocked by naf/3, **CURSOR NEXT (P0)**.

---

## Skipped / Cursor-owned
- **Cluster 2 — Agentic hygiene**: ai/2 context-isolation, ai/3 lesson-memory-hygiene, ai/4 scoped-rules-trim, ai/5 mcp-selective, ai/6 cursor-hooks-parity, ai/8 skills-discovery, ai/9 commands-playbooks, ai/10 agents-md-bridge. Config/docs tasks for Cursor's own tooling, partially maintained by Cursor already — defer entirely, don't pick up from Claude side.

---

## Cluster 4 — Home + scanner + picks (NEXT — extract scanner-reasoning.ts first)
- naf/4 home-dashboard-redesign (L)
- naf/5 scanner-simplified-view (M) — **CLAUDE NEXT (P1)** — simple/advanced toggle
- naf/6 todays-top-picks-feed (M)

---

## Cluster 5 — Macro tabs (10+11 together; 17/18/19 can follow)
- enh/10 macro-regime-tab-improvements (M)
- enh/11 macro-catalyst-calendar-improvements (M)
- enh/17 macro-volatility-tab-improvements (M) — done 2026-07-13: Volatility Regime Read implication card (VIX level, term structure, VVIX, put/call, HY credit cross-check, MOVE index → overall verdict), new MOVE index fetch/chart, /sentiment redirects to /macro?tab=volatility (ExtremesTable was already redundant with CotSection's inline extremes table, so no separate extraction was needed)
- enh/18 macro-policy-tab-improvements (S)
- enh/19 macro-heatmap-tab-improvements (S)

---

## Cluster 6 — Portfolio risk + daily brief + journal
- bug/14 portfolio-localstorage-not-server — done (conditional); two P0 follow-ups still open, see `FOLLOWUPS.md`
- enh/8 portfolio-analysis-improvements (L) — done 2026-07-13: UI overhaul shipped (theme/nav contrast, compact marquee summary strip, compact CSV import button, Robinhood-header row removed). Phase A1 (unlock nav) still deferred 2026-07-11, see task file rescope note; Phase B (wheel-cycle/journal) still design-gated backlog
- enh/9 portfolio-daily-brief-improvements (M)
- ai/13 product-ai-trade-journal-loop (L) — shares journal schema with enh/8

---

## Cluster 7 — Analyst data + breakdown
- enh/6 analyst-data-persistence (L) — Track 1 DONE 2026-07-11: schema applied (yahoo_analyst_actions + analyst_events), NVDA backfilled+verified, fixed inArray staleness-check bug + missing API Monitor success logging, wired analystActions into a compact color-coded "Analyst Rating Changes" table in stock-breakdown.tsx. Track 2 (Finviz per-firm PT) still pending spike.
- enh/12 stock-breakdown-sections-improvements (L)

---

## Cluster 8 — Feed + leaderboard (shared sample-size rules)
- naf/7 analyst-leaderboard-track-record (L)
- enh/13 feed-improvements (M)
- enh/14 profile-track-record-improvements (M)

---

## Cluster 9 — Research sprints (each spawns follow-ons)
- enh/30 liquidity-money-flow-research (M) — done 2026-07-13: Liquidity tab built end to end (plumbing diagram, net liq/RRP/MMF/NFCI/reserves/SOFR-IORB charts, liquidity regime implication card, sector rotation redesign with 1d-movers strip + sector names + magnitude-sized bubbles). Superseded the planned enh/31+32 split — both folded into this single build.
- enh/33 csp-momentum-backtest-learning-research (M) — standalone, can run independently of enh/34 (confirmed by user 2026-07-11). Spawns its own follow-on research tasks on pickup, feeds ai/14; don't assume those spawns are numbered 34/35 — enh/34 is already performance-resilience-optimization.
- ai/14 product-ai-trader-account-research (M) → spawns ai/15–17

---

## Cluster 10 — Standalone polish (any order)
- enh/15 technical-scorecard-improvements (M)
- enh/16 watchlist-monitor-improvements (M)
- enh/20 scorecard-guide-improvements (S)
- enh/21 settings-trader-preferences-improvements (M)
- naf/2 onboarding-product-tour (M)
- naf/8 command-palette-navigation (M) — **CLAUDE NEXT (P2)** — cmdk already installed
- naf/9 social-sentiment-polish (M–L)
- ai/12 product-ai-data-quality-chat (M) — needs enh/23 first

---

## Cluster 11 — Tech debt / infra (can batch or do one at a time)
- enh/22 openapi-coverage-orval-migration (L)
- enh/23 data-freshness-monitoring (S) — DONE 2026-07-11: bronze row counts (polygon/av) added to data-health route + ApiMonitorTab
- enh/24 polygon-av-backfill-completion (M) — DONE 2026-07-11: bronze populated (polygon 161 rows, av 14 rows), stale FIELD_DEFS comment fixed; AV rotation not on a cron (expected, deferred to enh/28) — re-run `backfill-av.ts` manually to continue the 25/day rotation
- enh/25 e2e-smoke-playwright (M) — after Cluster 1 CI is green ✅
- enh/26 react-query-fetch-standardization (M) — DONE 2026-07-11: query-keys.ts + App staleTime + unified rankings key via enh/34 Wave B; regime "duplicate" (W4) was N/A — renamed scanner's VIX endpoint to /volatility/regime instead of merging two unrelated regime taxonomies

---

## Key dependency rules
- ai/12 requires enh/23
- ai/13 requires enh/8 journal schema design
- ai/14 requires ai/13 + enh/33
- enh/9 requires enh/8
- enh/12 analyst section requires enh/6 Track 1
- naf/4–6 require scanner-reasoning.ts extract
- enh/30 done 2026-07-13, no longer spawns enh/31+32 separately (folded in) — enh/19 heatmap still untouched, no collision
- enh/27–29 are permanently deferred (goals already met by existing code) — re-confirmed 2026-07-11, no code changes since 2026-07-09 audit bypass this
