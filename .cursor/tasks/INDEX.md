# PM Backlog

Layout (2026-07-09). Filename = `{seq}-{slug}-070926.md` — **seq is build order within that folder**.

| Folder | What goes here |
|---|---|
| [`new_app_features/`](new_app_features/) | New product UX surfaces |
| [`enhancements/`](enhancements/) | Improve existing + engineering |
| [`ai/`](ai/) | Dev agentic harness + product AI |
| [`bugs/`](bugs/) | Production bugs, scale/multi-user, perf drift (fix tasks) |

Root: `INDEX.md` only. **Fully-done task files are deleted, not archived** (2026-07-14) — git history is the record of what shipped and how; this file only tracks what's still open. Partial-done tasks (marked `done*`) keep their file since real scope remains.

---

## new_app_features/ (seq 1→9)

| # | P | Status | File |
|---|---|---|---|
| 1 | P0 | done (research) | [competitive-ux-research](new_app_features/1-competitive-ux-research-070926.md) — kept: cited by 2/6/8/9 as source |
| 2 | P0 | ready | [onboarding-product-tour](new_app_features/2-onboarding-product-tour-070926.md) |
| 4 | P0 | ready | [home-dashboard-redesign](new_app_features/4-home-dashboard-redesign-070926.md) |
| 5 | P1 | ready | [scanner-simplified-view](new_app_features/5-scanner-simplified-view-070926.md) |
| 6 | P1 | ready | [todays-top-picks-feed](new_app_features/6-todays-top-picks-feed-070926.md) |
| 7 | P1 | ready | [analyst-leaderboard-track-record](new_app_features/7-analyst-leaderboard-track-record-070926.md) |
| 8 | P2 | ready | [command-palette-navigation](new_app_features/8-command-palette-navigation-070926.md) |
| 9 | P2 | ready | [social-sentiment-polish](new_app_features/9-social-sentiment-polish-070926.md) |

naf/3 contextual-score-explanations shipped (done) — file deleted 2026-07-14, see git log.

Deps: 2 before heavy UI; extract `lib/scanner-reasoning.ts` before/with 4–6; 8 after nav stable.

---

## enhancements/ (seq 1→38)

| # | P | Status | File |
|---|---|---|---|
| 1 | P0 | done (research) | [feature-purpose-research](enhancements/1-feature-purpose-research-070926.md) — kept: cited as Source by most tasks below |
| 2 | P0 | done (research) | [competitive-tech-research](enhancements/2-competitive-tech-research-070926.md) — kept: cited by research/data-source-integration |
| 6 | P1 | done* | [analyst-data-persistence](enhancements/6-analyst-data-persistence-070926.md) — Track 1 done, Track 2 (Finviz per-firm PT) pending |
| 8 | P0 | done* | [portfolio-analysis-improvements](enhancements/8-portfolio-analysis-improvements-070926.md) — UI overhaul done; A1 nav-unlock + Phase B journal still open (blocked on bug/14 P0, see FOLLOWUPS.md) |
| 9 | P1 | ready | [portfolio-daily-brief-improvements](enhancements/9-portfolio-daily-brief-improvements-070926.md) |
| 12 | P1 | done* | [stock-breakdown-sections-improvements](enhancements/12-stock-breakdown-sections-improvements-070926.md) — A1-A3,A5,A6 shipped; A4 (clickable competitors) regressed by in-progress Competitors v2 rework, re-verify on landing |
| 13 | P1 | ready | [feed-improvements](enhancements/13-feed-improvements-070926.md) |
| 14 | P1 | ready | [profile-track-record-improvements](enhancements/14-profile-track-record-improvements-070926.md) |
| 19 | P2 | ready | [macro-heatmap-tab-improvements](enhancements/19-macro-heatmap-tab-improvements-070926.md) |
| 20 | P1 | ready | [scorecard-guide-improvements](enhancements/20-scorecard-guide-improvements-070926.md) |
| 21 | P2 | ready | [settings-trader-preferences-improvements](enhancements/21-settings-trader-preferences-improvements-070926.md) |
| 22 | P1 | ready | [openapi-coverage-orval-migration](enhancements/22-openapi-coverage-orval-migration-070926.md) |
| 25 | P2 | ready | [e2e-smoke-playwright](enhancements/25-e2e-smoke-playwright-070926.md) |
| 27 | P3 | backlog | [precomputed-rankings-materialization](enhancements/27-precomputed-rankings-materialization-070926.md) — deferred, re-confirmed |
| 28 | P3 | backlog | [job-queue-background-workers](enhancements/28-job-queue-background-workers-070926.md) — deferred, re-confirmed |
| 29 | P3 | backlog | [redis-optional-shared-cache](enhancements/29-redis-optional-shared-cache-070926.md) — deferred, re-confirmed |
| 33 | P0 | ready | [csp-momentum-backtest-learning-research](enhancements/33-csp-momentum-backtest-learning-research-070926.md) — standalone, independent of 34 |
| 35 | P2 | backlog | [ai-explanation-quality-improvements](enhancements/35-ai-explanation-quality-improvements-071326.md) — filed 2026-07-13, cross-cutting pass on every implication/brief/note section (volatility, liquidity, regime, COT, daily brief, scorecard) |
| 36 | P2 | backlog | [macro-policy-forward-guidance-depth](enhancements/36-macro-policy-forward-guidance-depth-071326.md) — filed 2026-07-13, needs new data sourcing: FOMC dissent counts/vote splits, statement lexical-shift tracking, press-conference Q&A nuance, Treasury Quarterly Refunding Announcements, IMF WEO, other central banks (ECB/BOJ/BOE), CME FedWatch-style cut/hike probabilities |
| 38 | P2 | backlog | [large-component-token-cost](enhancements/38-large-component-token-cost-071426.md) — filed 2026-07-14, split oversized files into section subcomponents; one file per session, not a big-bang pass |

Fully-done, files deleted 2026-07-14 (see git log): enh/3 ci-pipeline, enh/4 api-integration-test-harness, enh/5 api-dev-hot-reload (folded into enh/34), enh/7 observability, enh/10 macro-regime-tab, enh/11 macro-catalyst-calendar, enh/15 technical-scorecard, enh/16 watchlist-monitor, enh/17 macro-volatility-tab, enh/18 macro-policy-tab, enh/23 data-freshness-monitoring, enh/24 polygon-av-backfill, enh/26 react-query-standardization, enh/30 liquidity-money-flow (shipped as Liquidity tab; no longer spawns 31/32), enh/34 performance-resilience (Waves A-D), enh/37 macro-cache-admin-visibility-gap.

Deps: 6 Track 1 before 12 analyst section; 8 before 9; 27–29 need explicit approval. enh/33 = momentum drivers + band regret + replay, standalone — its future spawn tasks should be numbered on pickup (use 39+, not 34/35/36 — those are taken); feeds `ai/14`.

---

## bugs/ (seq 14, 19 open; 1–18 fully done)

Merged from the former `bugs/INDEX.md` (deleted 2026-07-11). Filename = `{seq}-{slug}-070926.md`, seq = fix priority wave, not strict dependency order. **Claude implement:** [`bugs/CLAUDE-IMPLEMENT.md`](bugs/CLAUDE-IMPLEMENT.md).

Bugs 1–3, 5–13, 15–18 fully done — files deleted 2026-07-14 (see git log). Live open items from that audit (P0/P1/P2 carry-forward) are tracked in [`FOLLOWUPS.md`](FOLLOWUPS.md), not lost with the files.

| # | P | Status | File |
|---|---|---|---|
| 14 | P1 | done (conditional) | [portfolio-localstorage-not-server](bugs/14-portfolio-localstorage-not-server-070926.md) — server-backed positions shipped; two P0 follow-ups open (`user_portfolio_names` schema gap, `portfolioSnapshots` missing userId), see FOLLOWUPS.md |
| 19 | P1 | rejected | [register-empty-watchlist](bugs/19-register-empty-watchlist-070926.md) — product decision |

Bug 4 (startup-universe-refresh-storm) done, file deleted; coupled to Cluster B fetch-overprocessing (also done).

---

## ai/ (seq 1→14)

| # | P | Status | File |
|---|---|---|---|
| 1 | P0 | done (reference) | [agentic-workflow-research](ai/1-agentic-workflow-research-070926.md) — kept: floors R1–R10 cited by every agentic/product-AI PRD |
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

Deps: 1 = reference (done, kept). **CURSOR.md shared PR** can ship 2+4+5+8+9+10 docs together. **ai/7 playbook merges into ai/9**. **ai/6 after ai/2**. **ai/11 after new_app_features/3** (shipped — see git log). **ai/12 after enh/23** (done — see git log). **ai/13 design with enhancements/8**; never writes lessons (**ai/3**). **ai/14** system AI trader — co-design tags with **13**/enh/**8**; drivers/regret from enh/**33**; soft liquidity from enh/30 (done — see git log); spawn **15–17** after checklist.

### Interconnect map (impl research 2026-07-09)

```
ai/1 floors (R1–R10) ──reference──► all
ai/2 wrap isolation ──► ai/6 hook reminder, ai/5 mcp warn, ai/9 wrap playbook
ai/3 lessons ──► ai/9 lesson playbook; blocks ai/13 from lessons.md
ai/4 rules inventory ──► same CURSOR.md PR as 2/5/8/10
ai/7 verify ──MERGE playbook──► ai/9
ai/9 playbooks = command SSOT
ai/11 ──dep──► new_app_features/3 ExplainableScore (shipped)
ai/12 ──dep──► enhancements/23 data-health (shipped)
ai/13 ──dep──► enhancements/8 journal schema; boundary ai/3
ai/14 ──dep──► ai/13 + enh/8 tags; enh/33 drivers/regret; soft enh/30 liquidity (shipped)
enh/33 ──feeds──► ai/14 memory; spawn 39+
```

Already-true (doc-only / verify): **ai/4** alwaysApply≤3; **ai/5** mcp=codegraph; **ai/3** cap script. Real build: **ai/2** wrap, **ai/6** hooks, **ai/8** skills table, **ai/9** playbooks, **ai/10** AGENTS link, **ai/11–13** product.

Every agentic/product-AI PRD includes full **Impact & Risk Analysis**.

---

## PM / review infrastructure

- `.cursor/rules/product-manager.mdc` + `.cursor/skills/product-manager.md` — write/ideate tasks
- `.cursor/rules/task-reviewer.mdc` + `.cursor/skills/task-reviewer.md` — **DoR / multi-lens PRD review** (not eng verifier)
- Next session: say **task reviewer** → review by folder seq (`ai/` then `new_app_features/` then `enhancements/`)
- `.cursor/tasks/{new_app_features,enhancements,ai}/` + this INDEX
