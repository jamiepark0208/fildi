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

## Skill-to-area mapping
Authoritative table is in `CLAUDE.md` (repo root) under the SKILLS section.
**All agents (Kiro, Claude Code, etc.):** read `CLAUDE.md` directly — it is plain markdown and contains skills, codegraph rules, key files, and project conventions.

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
Active hooks (in `.claude/settings.local.json`):

| Hook | Trigger | Effect |
|---|---|---|
| codegraph-precheck | PreToolUse Edit\|Write | Injects entry points + related symbols for the target file (no code blocks) |
| session-wrap | Stop | Saves state to `.claude/state.json`, writes session log |
| rehydrate | UserPromptSubmit | Session banner, codegraph status, API health check |

**Manual equivalent for other agents:**
- Session start: Check API health: `curl -s http://localhost:8080/api/daily-brief | head -c 60`
- Session end: `node .claude/scripts/session-wrap.js`
- Context management (no hook — apply manually): if a prompt > 120 words, load the relevant skill file first; if context > 40%, compact before starting a large task
- Auto-compact fires at 45% in Claude Code (CLAUDE_AUTOCOMPACT_PCT_OVERRIDE=45)
