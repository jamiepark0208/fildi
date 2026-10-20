# FILDI — selective context map
Purpose: route questions, not preload the repository. Paths checked 2026-10-19; verify current source and status.

## Product and financial reasoning
- `.agents/context/INDEX.md`: domain topics, data sources/cadence, scoring, research, operations.
- `.agents/context/fildi-feature-synthesis.md`: product decision layers, Model List, risk, scores, macro, news. Verify its live/planned claims; do not assume its design is empirically proven.
- `scripts/watchlist_sync/FACTOR_MAP.md`: factor ownership/overlap; `research/studies/INDEX.md` → relevant report, methods, code. `METHODS.md`/`PLAYBOOK.md`: decision-specific targets, controls, point-in-time data, realistic fills, statistical checks. Do not load all study reports.
- Scoring/synthesis entrypoints: `artifacts/api-server/src/lib/fund-score-engine.ts`, `street-synthesis.ts`, `regime-classifier.ts` in that same lib directory; options components live in `lib/option-scoring`. Use code search to trace current technical/options engines and their consumers.
- Feedback/accountability: `artifacts/api-server/src/lib/model-track-record.ts`, `conviction-ledger.ts`; `scripts/watchlist_sync/forecast_ledger.py`. Check corresponding routes/UI, snapshots, grading horizons, and update mechanisms. Existence is not proof of learning or efficacy.
- Technology: workspace/package manifests, route registration, `scripts/maintain.mjs`, `artifacts/api-server/src/lib/scheduled-tasks-inventory.ts`; topic index for DB/data-source/refresh contracts.

## Team workflow — orientation, not a new Codex role
- `AGENTS.md`: policy/ownership/reviews/sync. `.agents/AGENT_OPS.md`: outcomes, claims, budget routing; `.agents/AGENTS.md`: routing catalog. Dated role/cost claims may be stale.
- `research/common/ASKS.md`: index → relevant `asks/A##.md`; `.agents/needs-jamie.md`: decisions; `research/common/OUTCOMES.md`: achieved outcomes. Read relevant rows without posting, claiming, or changing statuses.
- AI tab: `/agents` → `artifacts/stock-compare/src/pages/agents.tsx` → `components/settings/AgentsTab.tsx` under the same src root. Stage/Ideas/Usage/Rules/Skills → `artifacts/api-server/src/routes/agents.ts`.
- UI rules read `.agents/rules.md`; skills read `.claude/skills`; events originate in `.agents/hooks/agent-event.mjs`. Runtime logs outside FILDI are outside this review. UI activity is not proof of achievement.
- Known onboarding caveat: sampled UI/API agent IDs omit Codex; `needs-inbox.mjs` may default an unknown agent to Claude. Do not run it as Codex, wire hooks, or turn onboarding into the assessment's mission.
- Role adapters (`CLAUDE.md`, `CURSOR.md`, `MUSE.md`, `GROK.md`), task claims, memory/session indexes: consult only for a concrete ownership/history question. Others own their state; archives are not startup context.
