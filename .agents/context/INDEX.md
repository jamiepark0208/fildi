# TradeDash context — retrieval map (shared)
> Cursor + Claude. Read **only** what the task needs. Prefer codegraph for code.

## Always-injected (tool-specific — do not merge these files)
| Tool | File | Role |
|---|---|---|
| Cursor | `.cursor/context/cursor-state.md` | Phase / next tasks — **Cursor writes** |
| Cursor | `.cursor/context/session.md` | Last Cursor session notes |
| Claude | `.agents/context/state.md` | Phase / next tasks — **Claude writes**; Cursor **read-only** |

## By topic (pick one)
| Topic | Canonical file | Do not open first |
|---|---|---|
| Agentic floors | `.agents/context/agentic-floors.md` | `.cursor/tasks/ai/1-*` full research PRD |
| Sector / peer scoring | `.agents/context/plans/fundamental-sector-scoring.md` | `.cursor/context/archive/` · `.cursor/plans/archive/` |
| Stock DB quality / NR | `.agents/context/stock-db-best-realistic.md` | Archived quality-audit snapshots |
| Fundamentals cadence | `.agents/context/fundamentals-refresh-cadence.md` | — |
| Earnings-window triggers | `.agents/context/event-driven-refresh.md` | — |
| Derived PEG/formulas | `.agents/context/derived-metrics-framework.md` | — |
| Data-ops value log | `.agents/context/data-ops-value-log.md` | — |
| API catalog | `.agents/context/api-endpoints.md` | — |
| Workflow / build | `.agents/context/workflow.md` | — |
| Agent routing | `.agents/AGENTS.md` | — |
| Weekly ops checklist | `.cursor/skills/weekly-data-ops-check.md` | — |
| Cursor lessons (grep) | `.cursor/context/lessons.md` | `lessons-archive.md` unless needed |
| Claude memory (grep) | `.agents/memory/MEMORY.md` | Load whole memory dir |

## Daily maintain (code SoT)
`scripts/maintain.mjs` → missing / earnings / drain / peer-health / post-merge-scores · LaunchAgent `com.fildi.maintain` · report `/tmp/fildi-logs/maintain-last.json`  
Technicals/options: **not** scheduled (ad-hoc on click).

## Ignore / archive
| Path | Why |
|---|---|
| `.cursor/plans/archive/` | Stale snapshots + duplicate plan export |
| `.cursor/context/archive/` | Old v1 plan stub |
| `.cursor/tasks/**` | PM backlog — not runtime SoT |
| `.claude/docs/phase-report*` | Claude historical handoffs — only if that task |
| `FUNDAMENTAL_WATCHLIST` | Removed from TS — do not re-add |

## Adapters
| Tool | Entry |
|---|---|
| Shared ToC | `AGENTS.md` (repo root) |
| Claude | `CLAUDE.md` |
| Cursor | `CURSOR.md` + `.cursor/rules/` |
| Skills | `.claude/skills/` (one at a time) |
