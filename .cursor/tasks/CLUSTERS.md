# Task Clusters — build groupings (updated 2026-07-11)

Tasks grouped by dependency / logical cohesion. Check `INDEX.md` for current bug status.

---

## Completed

All done tasks — detail lives in each task's own (now-condensed) .md file and in `INDEX.md`, not duplicated here:
- **Bugs 1–18** — done (19 rejected, product decision).
- **enh/1, 2, 3, 4, 5, 6 (Track 1), 7, 8 (main), 10, 11, 12 (A1-A3,A5,A6), 17, 18, 23, 24, 26, 30, 34, 37**
- **naf/1, naf/3**
- **ai/1**

Cluster 3 note: ai/11 product-ai-explain-csp was unblocked by naf/3 — **CURSOR NEXT (P0)**.

---

## Skipped / Cursor-owned
- **Cluster 2 — Agentic hygiene**: ai/2 context-isolation, ai/3 lesson-memory-hygiene, ai/4 scoped-rules-trim, ai/5 mcp-selective, ai/6 cursor-hooks-parity, ai/8 skills-discovery, ai/9 commands-playbooks, ai/10 agents-md-bridge. Config/docs tasks for Cursor's own tooling, partially maintained by Cursor already — defer entirely, don't pick up from Claude side.

---

## Cluster 4 — Home + scanner + picks (NEXT — extract scanner-reasoning.ts first)
- naf/4 home-dashboard-redesign (L)
- naf/5 scanner-simplified-view (M) — **CLAUDE NEXT (P1)** — simple/advanced toggle
- naf/6 todays-top-picks-feed (M)

---

## Cluster 5 — Macro tabs (10/11/17/18 done; 19 open)
- enh/10, 11, 17, 18 — done, see INDEX.md
- enh/19 macro-heatmap-tab-improvements (S)

---

## Cluster 6 — Portfolio risk + daily brief + journal
- bug/14 — done (conditional), two P0 follow-ups open, see `FOLLOWUPS.md`
- enh/8 portfolio-analysis-improvements (L) — main UI overhaul done, A1 nav-unlock + Phase B journal still open, see task file
- enh/9 portfolio-daily-brief-improvements (M)
- ai/13 product-ai-trade-journal-loop (L) — shares journal schema with enh/8

---

## Cluster 7 — Analyst data + breakdown
- enh/6 analyst-data-persistence (L) — Track 1 done, Track 2 (Finviz per-firm PT) still pending spike
- enh/12 stock-breakdown-sections-improvements (L) — done except A4 (clickable competitors), which the in-progress Competitors v2 rework (uncommitted) currently regresses — re-verify once that lands

---

## Cluster 8 — Feed + leaderboard (shared sample-size rules)
- naf/7 analyst-leaderboard-track-record (L)
- enh/13 feed-improvements (M)
- enh/14 profile-track-record-improvements (M)

---

## Cluster 9 — Research sprints (each spawns follow-ons)
- enh/30 liquidity-money-flow-research (M) — done, Liquidity tab shipped end-to-end; folded planned enh/31+32 into this single build
- enh/33 csp-momentum-backtest-learning-research (M) — standalone, independent of enh/34. Spawns own follow-on tasks on pickup (don't assume 34/35 — those numbers are taken), feeds ai/14
- ai/14 product-ai-trader-account-research (M) → spawns ai/15–17

---

## Cluster 10 — Standalone polish (any order)
- enh/15 technical-scorecard-improvements (M)
- enh/16 watchlist-monitor-improvements (M)
- enh/20 scorecard-guide-improvements (S)
- enh/21 settings-trader-preferences-improvements (M)
- enh/35 ai-explanation-quality-improvements (M) — backlog, filed 2026-07-13: cross-cutting pass on every implication/brief/note-generating section (volatility, liquidity, regime, COT, daily brief, scorecard) — the COT `CotPositioningRead` narrative added this session is a first draft of the pattern, not the final bar
- enh/36 macro-policy-forward-guidance-depth (M) — backlog, filed 2026-07-13: Policy tab covers rate path/dots/SEP/Fed stances/bank views but not FOMC dissent counts, statement lexical shifts ("elevated"→"transitory"), press-conference nuance, Treasury Quarterly Refunding Announcements, IMF WEO, other central banks, or FedWatch-style probabilities — needs new data sourcing (FOMC statement/minutes text, Treasury refunding calendar, IMF/ECB/BOJ/BOE feeds), bigger lift than enh/18's compaction pass; also now carries user's historical-analogy/pattern-matching request (tagged event history + market-reaction windows, e.g. "last time X, market did Y")
- enh/37 — done, see INDEX.md
- naf/2 onboarding-product-tour (M)
- naf/8 command-palette-navigation (M) — **CLAUDE NEXT (P2)** — cmdk already installed
- naf/9 social-sentiment-polish (M–L)
- ai/12 product-ai-data-quality-chat (M) — needs enh/23 first

---

## Cluster 11 — Tech debt / infra (can batch or do one at a time)
- enh/22 openapi-coverage-orval-migration (L)
- enh/23, 24, 26 — done, see INDEX.md
- enh/25 e2e-smoke-playwright (M) — after Cluster 1 CI is green ✅
- enh/38 large-component-token-cost (M, per file) — split MacroComponents.tsx / stock-breakdown.tsx / portfolio-analysis.tsx etc; one file per session

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
