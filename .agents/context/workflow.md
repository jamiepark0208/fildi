# TradeDash — Workflow Rules
> last_updated: 2026-06-10 | update when build process, routing, or tooling changes

## Backend build (CRITICAL — causes 502s if skipped)
After ANY change to `artifacts/api-server/src/**`, rebuild and restart:
```bash
pkill -f "api-server/dist/index" 2>/dev/null; sleep 0.3 && cd /home/runner/workspace/artifacts/api-server && node build.mjs && PORT=8080 node --enable-source-maps /home/runner/workspace/artifacts/api-server/dist/index.mjs >> /tmp/api-server.log 2>&1 & sleep 2 && curl -s "http://localhost:8080/api/daily-brief" | head -c 60
```
The server does NOT hot-reload. Vite frontend hot-reloads automatically.

## Routing rules (never repeat these bugs)
- Route files define paths **WITHOUT** `/api` prefix — e.g. `router.get("/indicators/:ticker")`
- Router is mounted at `/api` in `src/index.ts` — prefix added there only
- Vite proxy: `"/api"` → `http://localhost:8080` in `vite.config.ts`
- Specific routes (`/options/position-quote`) **MUST** be declared **BEFORE** wildcard routes (`/options/:ticker`) or the wildcard swallows them

## Model routing
| Model | Use for |
|---|---|
| haiku | Data fetching, cache boilerplate, scaffolding, verifier |
| sonnet | UI, filter logic, API design, debugging (default) |
| opus | /opus flag only — architecture rewrites |

## Rate limit rules
- Max 3 bash tool calls per response
- After a build command: wait for output before next call
- Never chain more than 2 curl/test commands back to back
- If 429 error: stop, wait 60s, resume with single tool call

## Reading rules
- Never use Explore agents for broad codebase sweeps
- Read files directly only when needed; state the file name and reason first
- Max 5 files per task without explicit user approval
- Use find/grep to locate files before reading them

## Debugging rules
- State the exact error/symptom before reading any file
- Read max 2 files before attempting a fix
- Fix one thing, verify it works, then move to the next
- Never refactor while debugging — fix only

## Data layer rules
- Cache-first: check DB/cache before any external call
- Max 3 concurrent fetches (Promise.allSettled)
- Never fetch options chain on page load — on-demand only
- Never re-fetch historical OHLCV already in `prices_historical`
- Connection pool max 5 (Replit free tier)
- Parameterized queries only — never string interpolation in SQL
- `ON CONFLICT DO UPDATE` for upserts, never DELETE+INSERT

## UI rules
- No new layout restructuring — add within existing card/row boundaries
- `text-xs` for secondary content, `text-sm` for primary body (default)
- No data fetching inside components — fetch in pages, pass as props
- All async data via `useQuery`, never `useEffect` fetch
- Max 150 lines per component file

## Skill-to-area mapping (see `.claude/skills/` for full detail)
| Area | Skill file |
|---|---|
| Options chain, strike selection, income% | `options-pricer.md` |
| RSI, MFI, filter logic, tier thresholds | `signal-filters.md` |
| Any UI component or new page | `ui-components.md` |
| New feature planning | `feature-planner.md` |
| Data fetching, caching, refresh logic | `data-architecture.md` |
| DB schema or migration | `db-patterns.md` |
| Trader strategy, scoring, ranking | `trader-context.md` |
| Technical scorecard UI or signals | `technical-scorecard.md` |
| Server build or 502 errors | `build-and-run.md` |
| End of session | `session-wrap.md` |

## Agents
| Agent | Use for |
|---|---|
| `verifier` | tsc + lint + tests after every feature |
| `data-agent` | yfinance + Redis/cache work (haiku) |
| `ui-agent` | React components (sonnet) |

## Session state
- Live session state: `.claude/state.json` (local, ephemeral — Claude Code only)
- Cross-agent tasks: `.agents/tasks/` (git-tracked, visible to all agents)
- Claude Code hooks: `.claude/settings.local.json` (local, not tracked)

## Codegraph (Claude Code only — use before touching any file)
```bash
codegraph context "<task>"    # relevant files + symbols before starting
codegraph impact <symbol>     # what breaks before changing a function
codegraph callers <symbol>    # all usages before refactoring
codegraph sync                # update index after bulk changes
```
Never read source files to understand structure — use codegraph context first.
**Kiro/other agents:** browse `artifacts/api-server/src/routes/` and `artifacts/stock-compare/src/` to understand structure manually.

## Skills usage
**Claude Code:** invoke via the Skill tool by name (e.g. `options-pricer`). Skills are in `.claude/skills/`.
**Kiro/other agents:** read `.claude/skills/<name>.md` directly. Key skill files:
- `build-and-run.md` — full server rebuild procedure and failure diagnosis
- `signal-filters.md` — RSI/MFI thresholds per ticker (authoritative)
- `options-pricer.md` — strike selection, income% calculation
- `trader-context.md` — strategy rationale and scoring philosophy
- `technical-scorecard.md` — V2 scorer architecture and DB schema

## Claude Code automation (hooks — automatic in Claude Code, manual for other agents)
These run automatically in Claude Code but must be applied manually in Kiro or other agents:

| Hook | Trigger | What it checks | Manual equivalent |
|---|---|---|---|
| prompt-preprocessor | Before Task/TodoWrite | Model routing hints; prompt > 120 words → use skill file; options chain → cache check | Check model table in this file before starting; keep prompts under 120 words |
| context-monitor | After every tool | Context > 40% → consider /compact; tool output > 15KB → summarize | Break large tasks into smaller steps; summarize large file reads before using |
| session-wrap | On session Stop | Saves state, syncs `.kiro/steering/03-state.md`, writes session log | Run `node .claude/scripts/session-wrap.js` manually or update `.agents/context/state.md` |
| rehydrate | On session Start | Shows session banner, syncs codegraph, auto-starts API server | Check API: `curl -s http://localhost:8080/api/daily-brief \| head -c 60`; start if needed with build command above |
