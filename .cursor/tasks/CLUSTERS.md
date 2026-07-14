# Task Clusters — build groupings (updated 2026-07-14)

Tasks grouped by dependency / logical cohesion. Check `INDEX.md` for current status. Fully-done tasks' files are deleted (git history is the record) — clusters below only list what's still open, or partial-done items with real remaining scope.

---

## Skipped / Cursor-owned
- **Cluster 2 — Agentic hygiene**: ai/2 context-isolation, ai/3 lesson-memory-hygiene, ai/4 scoped-rules-trim, ai/5 mcp-selective, ai/6 cursor-hooks-parity, ai/7 verifier-gate, ai/8 skills-discovery, ai/9 commands-playbooks, ai/10 agents-md-bridge. Config/docs tasks for Cursor's own tooling, partially maintained by Cursor already — defer entirely, don't pick up from Claude side.

---

## Cluster 4 — Home + scanner + picks (NEXT — extract scanner-reasoning.ts first)
- naf/4 home-dashboard-redesign (L)
- naf/5 scanner-simplified-view (M) — **CLAUDE NEXT (P1)** — simple/advanced toggle
- naf/6 todays-top-picks-feed (M)

---

## Cluster 5 — Macro tabs
- All done — 10/11/17/18/19 shipped, files deleted (see git log)

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
- enh/13 feed-improvements (M) — done*, W1-W3/W5-W7 shipped, W4 trending strip still open
- enh/14 profile-track-record-improvements (M) — done*, Phase A shipped, Phase B tags design-gated with ai/13

---

## Cluster 9 — Research sprints (each spawns follow-ons)
- enh/33 csp-momentum-backtest-learning-research (M) — standalone, independent of enh/34 (done). Spawns own follow-on tasks on pickup (use 39+ — 34/35/36 taken), feeds ai/14
- ai/14 product-ai-trader-account-research (M) → spawns ai/15–17
- enh/30 liquidity-money-flow-research — done, Liquidity tab shipped end-to-end; folded 31/32 into this build; enh/19 heatmap untouched, no collision

---

## Cluster 10 — Standalone polish (any order)
- enh/35 ai-explanation-quality-improvements (M) — backlog, filed 2026-07-13: cross-cutting pass on every implication/brief/note-generating section (volatility, liquidity, regime, COT, daily brief, scorecard) — the COT `CotPositioningRead` narrative is a first draft of the pattern, not the final bar
- enh/36 macro-policy-forward-guidance-depth (M) — backlog, filed 2026-07-13: Policy tab covers rate path/dots/SEP/Fed stances/bank views but not FOMC dissent counts, statement lexical shifts, press-conference nuance, Treasury Quarterly Refunding Announcements, IMF WEO, other central banks, or FedWatch-style probabilities — needs new data sourcing, bigger lift than enh/18's compaction pass; also carries the historical-analogy/pattern-matching request (tagged event history + market-reaction windows)
- naf/2 onboarding-product-tour (M)
- naf/8 command-palette-navigation (M) — **CLAUDE NEXT (P2)** — cmdk already installed
- naf/9 social-sentiment-polish (M–L)
- ai/12 product-ai-data-quality-chat (M) — dep (enh/23) already shipped, so unblocked

---

## Cluster 11 — Tech debt / infra (can batch or do one at a time)
- enh/22 openapi-coverage-orval-migration (L) — backlog 2026-07-14, deferred: pays off with multiple contributors, not a solo prototype
- enh/25 e2e-smoke-playwright (M) — backlog 2026-07-14, deferred: regression net for CI/multi-dev/live users; Replit Preview covers manual checks for now, weekly file restructuring would churn selectors
- enh/38 large-component-token-cost (M, per file) — split oversized files (MacroComponents.tsx done; stock-breakdown.tsx done; others remain); one file per session

---

## Key dependency rules
- ai/12 requires enh/23 (shipped)
- ai/13 requires enh/8 journal schema design
- ai/14 requires ai/13 + enh/33
- enh/9 requires enh/8
- enh/12 analyst section requires enh/6 Track 1
- naf/4–6 require scanner-reasoning.ts extract
- enh/27–29 are permanently deferred (goals already met by existing code) — re-confirmed 2026-07-11, no code changes since 2026-07-09 audit bypass this
