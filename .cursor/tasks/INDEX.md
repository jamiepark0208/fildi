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
| 5 | P1 | done | [api-dev-hot-reload](enhancements/5-api-dev-hot-reload-070926.md) — folded into enh/34 Wave D 2026-07-11 |
| 6 | P1 | done | [analyst-data-persistence](enhancements/6-analyst-data-persistence-070926.md) — Track 1 done 2026-07-11 (schema applied, NVDA verified, 2 bugs fixed, UI wired); Track 2 (Finviz PT) still pending spike |
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
| 23 | P2 | done | [data-freshness-monitoring](enhancements/23-data-freshness-monitoring-070926.md) — bronze row counts added 2026-07-11 |
| 24 | P2 | done | [polygon-av-backfill-completion](enhancements/24-polygon-av-backfill-completion-070926.md) — bronze populated + stale comment fixed 2026-07-11, AV rotation not cron'd (expected) |
| 25 | P2 | ready | [e2e-smoke-playwright](enhancements/25-e2e-smoke-playwright-070926.md) |
| 26 | P2 | done | [react-query-fetch-standardization](enhancements/26-react-query-fetch-standardization-070926.md) — rankings key + App staleTime via enh/34 Wave B; regime "duplicate" was N/A (two unrelated products), scanner endpoint renamed to /volatility/regime for clarity 2026-07-11 |
| 27 | P3 | backlog | [precomputed-rankings-materialization](enhancements/27-precomputed-rankings-materialization-070926.md) — re-confirmed deferred 2026-07-11 |
| 28 | P3 | backlog | [job-queue-background-workers](enhancements/28-job-queue-background-workers-070926.md) — re-confirmed deferred 2026-07-11 |
| 29 | P3 | backlog | [redis-optional-shared-cache](enhancements/29-redis-optional-shared-cache-070926.md) — re-confirmed deferred 2026-07-11 |
| 30 | P0 | ready | [liquidity-money-flow-research](enhancements/30-liquidity-money-flow-research-070926.md) |
| 33 | P0 | ready | [csp-momentum-backtest-learning-research](enhancements/33-csp-momentum-backtest-learning-research-070926.md) — standalone, can run independently of 34 |
| 34 | P0 | done | [performance-resilience-optimization](enhancements/34-performance-resilience-optimization-070926.md) — Waves A–D done 2026-07-11 |

Deps: 3–4 before confident builds; 6 Track 1 before 12 analyst section; 8 before 9; 10+11 together; 23 before `ai/12` DQ chat; 27–29 need explicit approval. **30** = liquidity research — spawn **31 plumbing** / **32 sector rotation** after checklist (do not collide with **19** Heatmap). **33** = momentum drivers + band regret + replay, standalone — its future spawn tasks should be numbered on pickup, not assumed to be 34/35 (34 is now performance-resilience-optimization, unrelated); feeds **ai/14**.

---

## bugs/ (seq 1→19)

Merged from the former `bugs/INDEX.md` (deleted 2026-07-11 — was a duplicate status source that had drifted out of sync with this file; this is now the single status source for bugs/). Filename = `{seq}-{slug}-070926.md`, seq = fix priority wave, not strict dependency order. **Claude implement:** [`bugs/CLAUDE-IMPLEMENT.md`](bugs/CLAUDE-IMPLEMENT.md) → matrix below → individual task §9–§13.

| # | Cluster | P | Status | Effort | Benefit | Impl risk | File |
|---|---|---|---|---|---|---|---|
| 1 | D | P0 | done | M | Critical | Med | [unauthenticated-vendor-routes](bugs/1-unauthenticated-vendor-routes-070926.md) |
| 2 | A | P0 | done | L | Critical | High | [watchlist-global-constant-split](bugs/2-watchlist-global-constant-split-070926.md) |
| 3 | A | P1 | done | S | High | Low | [home-hardcoded-fundamental-universe](bugs/3-home-hardcoded-fundamental-universe-070926.md) |
| 4 | — | P0 | done | M | High | Med | [startup-universe-refresh-storm](bugs/4-startup-universe-refresh-storm-070926.md) |
| 5 | C | P1 | done | S | High | Low | [ttlcache-unbounded-memory](bugs/5-ttlcache-unbounded-memory-070926.md) |
| 6 | C | P1 | done | S | Med | Low | [pg-pool-session-contention](bugs/6-pg-pool-session-contention-070926.md) |
| 7 | D | P2 | done | S–L | Med | Low–Med | [rate-limit-single-instance](bugs/7-rate-limit-single-instance-070926.md) |
| 8 | C | P1 | done | M | Med | Med | [scheduler-restart-drift](bugs/8-scheduler-restart-drift-070926.md) |
| 9 | B | P1 | done | S | Med | Med | [watchlist-peer-flag-cascade](bugs/9-watchlist-peer-flag-cascade-070926.md) |
| 10 | A | P1 | done | XS | Med | Low | [watchlist-no-max-size](bugs/10-watchlist-no-max-size-070926.md) |
| 11 | B | P1 | done | M | High | Med | [options-scanner-fetch-storm](bugs/11-options-scanner-fetch-storm-070926.md) |
| 12 | B | P1 | done | M | Med | Low | [watchlist-quote-n-plus-one](bugs/12-watchlist-quote-n-plus-one-070926.md) |
| 13 | A | P1 | done | XS | Med | Low | [react-query-cross-user-bleed](bugs/13-react-query-cross-user-bleed-070926.md) |
| 14 | F | P1 | done (conditional) | L | High | High | [portfolio-localstorage-not-server](bugs/14-portfolio-localstorage-not-server-070926.md) |
| 15 | E | P2 | done | S | Med | Low | [catalyst-dual-buildCatalysts](bugs/15-catalyst-dual-buildCatalysts-070926.md) |
| 16 | E | P2 | done | S | Med | Low | [feed-winrate-expired-excluded](bugs/16-feed-winrate-expired-excluded-070926.md) |
| 17 | D | P2 | done | XS | Low | Low | [admin-routes-auth-not-admin](bugs/17-admin-routes-auth-not-admin-070926.md) |
| 18 | C | P2 | done | S | Med | Low | [session-table-growth](bugs/18-session-table-growth-070926.md) |
| 19 | A | P1 | rejected | S | High | Low | [register-empty-watchlist](bugs/19-register-empty-watchlist-070926.md) |

**Clusters** (read together, implement in order):
- **A — Watchlist SSOT (multi-user)** — 19, 2, 3, 10, 13 — DONE 2026-07-10 except 19 (rejected, product decision — see task DONE note). **Coupling:** fix 2 without `indicators.ts` → scanner 404 on user-added tickers.
- **B — Fetch overprocessing** — 9, 11, 12 — DONE 2026-07-11. **Coupling:** 9 shrinks `fetch_fundamentals` registry → affects 4's startup universe size.
- **C — Continuous-run health** — 5, 6, 8, 18. ALL DONE 2026-07-11: 5 (prune + maxEntries LRU, TTLs unchanged), 6 (pool max/idleTimeout env-tunable), 8 (last-run persisted to `app_config`, not `scoring_config`), 18 (`pruneSessionInterval: 900` on PgSession).
- **D — Security** — 1, 7, 17. ALL DONE: 1 (2026-07-10, router-level `requireAuth`, live curl-verified), 7 (2026-07-11, `trust proxy` prod-only), 17 (2026-07-11, admin GETs now `requireAdmin`, live curl-verified 401).
- **E — Correctness (small)** — 15, 16. DONE 2026-07-11 both: 15 (deleted duplicate FE `buildCatalysts`, server is now sole source), 16 (server winRate SQL now matches client resolved-status set).
- **F — Portfolio (large)** — 14 DONE 2026-07-11: `use-portfolio.ts` rewritten server-backed (`/api/positions` + `/api/portfolio-names`, previously unmounted router — now mounted), one-time localStorage migration shim, admin/regular-user split in `portfolio.tsx` (admin keeps RH-CSV view, regular users get revived manual-entry `PortfolioBox`). Done together with [enh/8](enhancements/8-portfolio-analysis-improvements-070926.md) Phase A1, which is **deferred** (nav stays `adminOnly: true`) — see enh/8 rescope note. A2–A4 still open.

Bug 4 isn't part of a lettered cluster but is coupled to cluster B. Block prod hardening until bug/1 (done). Tie prevention to **enh/3** + **enh/4** when landing fixes.

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
