# PM Backlog

Layout (2026-07-09). Filename = `{seq}-{slug}-070926.md` — **seq is build order within that folder**.

| Folder | What goes here |
|---|---|
| [`new_app_features/`](new_app_features/) | New product UX surfaces |
| [`enhancements/`](enhancements/) | Improve existing + engineering |
| [`ai/`](ai/) | Dev agentic harness + product AI |
| [`bugs/`](bugs/) | Production bugs, scale/multi-user, perf drift (fix tasks) |

Root: `INDEX.md` only. Done → `archive/`.

---

## new_app_features/ (seq 1→9)

| # | P | Status | File |
|---|---|---|---|
| 1 | P0 | done | [competitive-ux-research](new_app_features/1-competitive-ux-research-070926.md) |
| 2 | P0 | ready | [onboarding-product-tour](new_app_features/2-onboarding-product-tour-070926.md) |
| 3 | P0 | done | [contextual-score-explanations](new_app_features/3-contextual-score-explanations-070926.md) |
| 4 | P0 | ready | [home-dashboard-redesign](new_app_features/4-home-dashboard-redesign-070926.md) |
| 5 | P1 | ready | [scanner-simplified-view](new_app_features/5-scanner-simplified-view-070926.md) |
| 6 | P1 | ready | [todays-top-picks-feed](new_app_features/6-todays-top-picks-feed-070926.md) |
| 7 | P1 | ready | [analyst-leaderboard-track-record](new_app_features/7-analyst-leaderboard-track-record-070926.md) |
| 8 | P2 | ready | [command-palette-navigation](new_app_features/8-command-palette-navigation-070926.md) |
| 9 | P2 | ready | [social-sentiment-polish](new_app_features/9-social-sentiment-polish-070926.md) |

Deps: 2 before heavy UI; 3 before product-ai explain (`ai/11`); extract `lib/scanner-reasoning.ts` before/with 4–6; 8 after nav stable.

---

## enhancements/ (seq 1→33)

| # | P | Status | File |
|---|---|---|---|
| 1 | P0 | done | [feature-purpose-research](enhancements/1-feature-purpose-research-070926.md) |
| 2 | P0 | done | [competitive-tech-research](enhancements/2-competitive-tech-research-070926.md) |
| 3 | P0 | done | [ci-pipeline-typecheck-tests](enhancements/3-ci-pipeline-typecheck-tests-070926.md) |
| 4 | P0 | done | [api-integration-test-harness](enhancements/4-api-integration-test-harness-070926.md) |
| 5 | P1 | ready | [api-dev-hot-reload](enhancements/5-api-dev-hot-reload-070926.md) |
| 6 | P1 | ready | [analyst-data-persistence](enhancements/6-analyst-data-persistence-070926.md) |
| 7 | P1 | done | [observability-error-tracking](enhancements/7-observability-error-tracking-070926.md) |
| 8 | P0 | ready | [portfolio-analysis-improvements](enhancements/8-portfolio-analysis-improvements-070926.md) |
| 9 | P1 | ready | [portfolio-daily-brief-improvements](enhancements/9-portfolio-daily-brief-improvements-070926.md) |
| 10 | P0 | ready | [macro-regime-tab-improvements](enhancements/10-macro-regime-tab-improvements-070926.md) |
| 11 | P1 | ready | [macro-catalyst-calendar-improvements](enhancements/11-macro-catalyst-calendar-improvements-070926.md) |
| 12 | P1 | ready | [stock-breakdown-sections-improvements](enhancements/12-stock-breakdown-sections-improvements-070926.md) |
| 13 | P1 | ready | [feed-improvements](enhancements/13-feed-improvements-070926.md) |
| 14 | P1 | ready | [profile-track-record-improvements](enhancements/14-profile-track-record-improvements-070926.md) |
| 15 | P1 | ready | [technical-scorecard-improvements](enhancements/15-technical-scorecard-improvements-070926.md) |
| 16 | P1 | ready | [watchlist-monitor-improvements](enhancements/16-watchlist-monitor-improvements-070926.md) |
| 17 | P1 | ready | [macro-volatility-tab-improvements](enhancements/17-macro-volatility-tab-improvements-070926.md) |
| 18 | P2 | ready | [macro-policy-tab-improvements](enhancements/18-macro-policy-tab-improvements-070926.md) |
| 19 | P2 | ready | [macro-heatmap-tab-improvements](enhancements/19-macro-heatmap-tab-improvements-070926.md) |
| 20 | P1 | ready | [scorecard-guide-improvements](enhancements/20-scorecard-guide-improvements-070926.md) |
| 21 | P2 | ready | [settings-trader-preferences-improvements](enhancements/21-settings-trader-preferences-improvements-070926.md) |
| 22 | P1 | ready | [openapi-coverage-orval-migration](enhancements/22-openapi-coverage-orval-migration-070926.md) |
| 23 | P2 | ready | [data-freshness-monitoring](enhancements/23-data-freshness-monitoring-070926.md) |
| 24 | P2 | ready | [polygon-av-backfill-completion](enhancements/24-polygon-av-backfill-completion-070926.md) |
| 25 | P2 | ready | [e2e-smoke-playwright](enhancements/25-e2e-smoke-playwright-070926.md) |
| 26 | P2 | ready | [react-query-fetch-standardization](enhancements/26-react-query-fetch-standardization-070926.md) |
| 27 | P3 | backlog | [precomputed-rankings-materialization](enhancements/27-precomputed-rankings-materialization-070926.md) |
| 28 | P3 | backlog | [job-queue-background-workers](enhancements/28-job-queue-background-workers-070926.md) |
| 29 | P3 | backlog | [redis-optional-shared-cache](enhancements/29-redis-optional-shared-cache-070926.md) |
| 30 | P0 | ready | [liquidity-money-flow-research](enhancements/30-liquidity-money-flow-research-070926.md) |
| 33 | P0 | ready | [csp-momentum-backtest-learning-research](enhancements/33-csp-momentum-backtest-learning-research-070926.md) |

Deps: 3–4 before confident builds; 6 Track 1 before 12 analyst section; 8 before 9; 10+11 together; 23 before `ai/12` DQ chat; 27–29 need explicit approval. **30** = liquidity research — spawn **31 plumbing** / **32 sector rotation** after checklist (do not collide with **19** Heatmap). **33** = momentum drivers + band regret + replay — spawn **34** data enrichment / **35** CSP replay after checklist; feeds **ai/14**.

---

## bugs/ (seq 1→19)

| # | P | Status | File |
|---|---|---|---|
| 1 | P0 | ready | [unauthenticated-vendor-routes](bugs/1-unauthenticated-vendor-routes-070926.md) |
| 2 | P0 | ready | [watchlist-global-constant-split](bugs/2-watchlist-global-constant-split-070926.md) |
| 3 | P1 | ready | [home-hardcoded-fundamental-universe](bugs/3-home-hardcoded-fundamental-universe-070926.md) |
| 4 | P0 | ready | [startup-universe-refresh-storm](bugs/4-startup-universe-refresh-storm-070926.md) |
| 5 | P1 | ready | [ttlcache-unbounded-memory](bugs/5-ttlcache-unbounded-memory-070926.md) |
| 6 | P1 | ready | [pg-pool-session-contention](bugs/6-pg-pool-session-contention-070926.md) |
| 7 | P2 | ready | [rate-limit-single-instance](bugs/7-rate-limit-single-instance-070926.md) |
| 8 | P1 | ready | [scheduler-restart-drift](bugs/8-scheduler-restart-drift-070926.md) |
| 9 | P1 | ready | [watchlist-peer-flag-cascade](bugs/9-watchlist-peer-flag-cascade-070926.md) |
| 10 | P1 | ready | [watchlist-no-max-size](bugs/10-watchlist-no-max-size-070926.md) |
| 11 | P1 | ready | [options-scanner-fetch-storm](bugs/11-options-scanner-fetch-storm-070926.md) |
| 12 | P1 | ready | [watchlist-quote-n-plus-one](bugs/12-watchlist-quote-n-plus-one-070926.md) |
| 13 | P1 | ready | [react-query-cross-user-bleed](bugs/13-react-query-cross-user-bleed-070926.md) |
| 14 | P1 | ready | [portfolio-localstorage-not-server](bugs/14-portfolio-localstorage-not-server-070926.md) |
| 15 | P2 | ready | [catalyst-dual-buildCatalysts](bugs/15-catalyst-dual-buildCatalysts-070926.md) |
| 16 | P2 | ready | [feed-winrate-expired-excluded](bugs/16-feed-winrate-expired-excluded-070926.md) |
| 17 | P2 | ready | [admin-routes-auth-not-admin](bugs/17-admin-routes-auth-not-admin-070926.md) |
| 18 | P2 | ready | [session-table-growth](bugs/18-session-table-growth-070926.md) |
| 19 | P1 | ready | [register-empty-watchlist](bugs/19-register-empty-watchlist-070926.md) |

Full matrix + waves: [`bugs/INDEX.md`](bugs/INDEX.md). **Claude implement:** [`bugs/CLAUDE-IMPLEMENT.md`](bugs/CLAUDE-IMPLEMENT.md) + [`bugs/CLUSTERS.md`](bugs/CLUSTERS.md). **Wave 1 fix order:** 1 → 4 → 19 → 2. Block prod hardening until **bugs/1**. Tie prevention to **enh/3** + **enh/4** when landing fixes.

---

## ai/ (seq 1→14)

| # | P | Status | File |
|---|---|---|---|
| 1 | P0 | done | [agentic-workflow-research](ai/1-agentic-workflow-research-070926.md) |
| 2 | P0 | ready | [agentic-safety-context-isolation](ai/2-agentic-safety-context-isolation-070926.md) |
| 3 | P0 | ready | [agentic-lesson-memory-hygiene](ai/3-agentic-lesson-memory-hygiene-070926.md) |
| 4 | P0 | ready | [agentic-scoped-rules-trim](ai/4-agentic-scoped-rules-trim-070926.md) |
| 5 | P0 | ready | [agentic-mcp-selective](ai/5-agentic-mcp-selective-070926.md) |
| 6 | P0 | ready | [agentic-cursor-hooks-parity](ai/6-agentic-cursor-hooks-parity-070926.md) |
| 7 | P1 | ready | [agentic-verifier-gate](ai/7-agentic-verifier-gate-070926.md) |
| 8 | P1 | ready | [agentic-skills-discovery](ai/8-agentic-skills-discovery-070926.md) |
| 9 | P1 | ready | [agentic-commands-playbooks](ai/9-agentic-commands-playbooks-070926.md) |
| 10 | P2 | ready | [agentic-agents-md-bridge](ai/10-agentic-agents-md-bridge-070926.md) |
| 11 | P0 | ready | [product-ai-explain-csp](ai/11-product-ai-explain-csp-070926.md) |
| 12 | P1 | ready | [product-ai-data-quality-chat](ai/12-product-ai-data-quality-chat-070926.md) |
| 13 | P1 | ready | [product-ai-trade-journal-loop](ai/13-product-ai-trade-journal-loop-070926.md) |
| 14 | P0 | ready | [product-ai-trader-account-research](ai/14-product-ai-trader-account-research-070926.md) |

Deps: 1 = reference (done). **CURSOR.md shared PR** can ship 2+4+5+8+9+10 docs together. **ai/7 playbook merges into ai/9**. **ai/6 after ai/2**. **ai/11 after new_app_features/3**. **ai/12 after/with enhancements/23**. **ai/13 design with enhancements/8**; never writes lessons (**ai/3**). **ai/14** system AI trader — co-design tags with **13**/enh/**8**; drivers/regret from enh/**33**; soft liquidity from enh/**30**; spawn **15–17** after checklist.

### Interconnect map (impl research 2026-07-09)

```
ai/1 floors (R1–R10) ──reference──► all
ai/2 wrap isolation ──► ai/6 hook reminder, ai/5 mcp warn, ai/9 wrap playbook
ai/3 lessons ──► ai/9 lesson playbook; blocks ai/13 from lessons.md
ai/4 rules inventory ──► same CURSOR.md PR as 2/5/8/10
ai/7 verify ──MERGE playbook──► ai/9
ai/9 playbooks = command SSOT
ai/11 ──dep──► new_app_features/3 ExplainableScore
ai/12 ──dep──► enhancements/23 data-health
ai/13 ──dep──► enhancements/8 journal schema; boundary ai/3
ai/14 ──dep──► ai/13 + enh/8 tags; enh/33 drivers/regret; soft enh/30 liquidity
enh/33 ──feeds──► ai/14 memory; spawn 34/35
```

Already-true (doc-only / verify): **ai/4** alwaysApply≤3; **ai/5** mcp=codegraph; **ai/3** cap script. Real build: **ai/2** wrap, **ai/6** hooks, **ai/8** skills table, **ai/9** playbooks, **ai/10** AGENTS link, **ai/11–13** product.

Deep packs (ai/2 intensity): **complete** for prior queue — **ai/2–13** + **enhancements/3–29** + **new_app_features/2–9**. New research ready: **enh/30** liquidity, **ai/14** AI trader, **enh/33** momentum/backtest (spawn 31/32 and 15–17 / 34/35 after checklists).

Every agentic/product-AI PRD includes full **Impact & Risk Analysis**.

---

## PM / review infrastructure

- `.cursor/rules/product-manager.mdc` + `.cursor/skills/product-manager.md` — write/ideate tasks
- `.cursor/rules/task-reviewer.mdc` + `.cursor/skills/task-reviewer.md` — **DoR / multi-lens PRD review** (not eng verifier)
- Next session: say **task reviewer** → review by folder seq (`ai/` then `new_app_features/` then `enhancements/`)
- `.cursor/tasks/{new_app_features,enhancements,ai}/` + this INDEX
