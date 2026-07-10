# Task Clusters — build groupings (2026-07-10)

Tasks grouped by dependency / logical cohesion. Check INDEX.md for current status of each task.

---

## Cluster 0 — Bugs + perf/resilience (CLAUDE ACTIVE — supersedes prior "CLAUDE NEXT" tags below until done)

Cursor filed 19 tasks in `bugs/` (own [CLUSTERS.md](bugs/CLUSTERS.md) / [CLAUDE-IMPLEMENT.md](bugs/CLAUDE-IMPLEMENT.md) / [INDEX.md](bugs/INDEX.md)) plus [enh/34 performance-resilience-optimization](enhancements/34-performance-resilience-optimization-070926.md), which explicitly depends on bug/4, 5, 11, 12, 13. Claude is gatekeeper: every bug is verified against live code before fixing — Cursor wrote these without running the app, so some may already be fixed or mis-scoped. Verified/actual status recorded per-task in the file itself, not assumed from Cursor's "ready" label.

Sub-clusters (from `bugs/CLUSTERS.md`, referenced not duplicated):
- **A — Watchlist SSOT** (19, 2, 3, 10, 13)
- **B — Fetch overprocessing** (9, 11, 12)
- **C — Continuous-run health** (5, 6, 8, 18)
- **D — Security** (1, 7, 17)
- **E — Correctness** (15, 16)
- **F — Portfolio** (14, coordinate enh/8)

**Build order (this session):** Wave 1 P0 bugs (1, 4, 19) → verify/fix Wave 2 (2, 3, 5, 6, 8, 11, 12, 13, 18) as time allows → enh/34 Waves A–D (A/B are net-new perf work; Wave C *is* bugs 4/5/11/12, don't double-implement) → Wave D devx.

**Status:** in progress — see per-file `Status` field for each bug/enh/34 as source of truth.

---

## Cluster 1 — CI / Test + Observability ✅ DONE
- enh/3 ci-pipeline — done (GitHub Actions on push/PR; typecheck + test both packages)
- enh/4 api-integration-test-harness — done (15-test unit harness for merge-trusted priority)
- enh/7 observability-error-tracking — done (Sentry + requestId wired; no-op without DSN)

---

## Cluster 2 — Agentic hygiene (SKIP — defer to Cursor)
- ai/2 context-isolation
- ai/3 lesson-memory-hygiene
- ai/4 scoped-rules-trim
- ai/5 mcp-selective
- ai/6 cursor-hooks-parity
- ai/8 skills-discovery
- ai/9 commands-playbooks
- ai/10 agents-md-bridge
> These are Cursor config / docs tasks. Ship as one CURSOR.md PR when ready. Risk of poor design is high.

---

## Cluster 3 — Score explanations + AI narration ✅ DONE (naf/3); ai/11 → Cursor next
- naf/3 contextual-score-explanations — **done 2026-07-10**
  - ExplainableScore component, useScoreExplanation hook, score-summary-copy.ts
  - explain_cache DB table (migration 0016), server-side caching in explain.ts
  - Refactored rankings-leaderboard + technical TechnicalLeaderboard
  - Sidebar renamed, scorecard deep-link wired
  - **follow-up 2026-07-10**: TechnicalLeaderboard "Why" panel now shows a metric z-score table (top 5 metrics, value + σ vs peers), matching the fundamental rankings-leaderboard pattern. Computed lazily, only for the expanded row. Also fixed a bug where the panel could expand but not collapse (added per-ticker `collapsed` toggle state).
- ai/11 product-ai-explain-csp — **CURSOR NEXT (P0)** — wire ExplainableScore into scanner expanded panel; details in CURSOR-HANDOFF-2026-07-10.md

---

## Cluster 4 — Home + scanner + picks (extract scanner-reasoning.ts first)
- naf/4 home-dashboard-redesign (L)
- naf/5 scanner-simplified-view (M) — **CLAUDE NEXT (P1)** — simple/advanced toggle
- naf/6 todays-top-picks-feed (M)

---

## Cluster 5 — Macro tabs (10+11 together; 17/18/19 can follow)
- enh/10 macro-regime-tab-improvements (M)
- enh/11 macro-catalyst-calendar-improvements (M)
- enh/17 macro-volatility-tab-improvements (M)
- enh/18 macro-policy-tab-improvements (S)
- enh/19 macro-heatmap-tab-improvements (S)

---

## Cluster 6 — Portfolio risk + daily brief + journal
- enh/8 portfolio-analysis-improvements (L) — ship first
- enh/9 portfolio-daily-brief-improvements (M)
- ai/13 product-ai-trade-journal-loop (L) — shares journal schema with enh/8

---

## Cluster 7 — Analyst data + breakdown
- enh/6 analyst-data-persistence (L) — Track 1 gates enh/12 analyst section
- enh/12 stock-breakdown-sections-improvements (L)

---

## Cluster 8 — Feed + leaderboard (shared sample-size rules)
- naf/7 analyst-leaderboard-track-record (L)
- enh/13 feed-improvements (M)
- enh/14 profile-track-record-improvements (M)

---

## Cluster 9 — Research sprints (each spawns follow-ons)
- enh/30 liquidity-money-flow-research (M) → spawns enh/31 + enh/32
- enh/33 csp-momentum-backtest-learning-research (M) → spawns enh/34 + enh/35 → feeds ai/14
- ai/14 product-ai-trader-account-research (M) → spawns ai/15–17

---

## Cluster 10 — Standalone polish (any order)
- enh/5 api-dev-hot-reload (S)
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
- enh/23 data-freshness-monitoring (S)
- enh/24 polygon-av-backfill-completion (M)
- enh/25 e2e-smoke-playwright (M) — after Cluster 1 CI is green ✅
- enh/26 react-query-fetch-standardization (M)

---

## Key dependency rules
- ai/11 requires naf/3 ✅ (now unblocked)
- ai/12 requires enh/23
- ai/13 requires enh/8 journal schema design
- ai/14 requires ai/13 + enh/33
- enh/9 requires enh/8
- enh/12 analyst section requires enh/6 Track 1
- naf/4–6 require scanner-reasoning.ts extract
- enh/30 spawns enh/31+32 (do not collide with enh/19 heatmap)
- enh/33 spawns enh/34+35
- enh/27–29 are permanently deferred (goals already met by existing code)
