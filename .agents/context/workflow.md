# TradeDash — Workflow Rules

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
