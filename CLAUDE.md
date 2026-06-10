# TradeDash — Claude Code Config
> Claude Code only. Full project context in .agents/. Rehydrate runs on every session start.

## STARTUP (every session)
Run: node .claude/scripts/rehydrate.js
First time only: tell Claude "read .claude/skills/replit-setup.md and follow the steps"

## SKILLS INDEX (load one at a time — never all at once)
| Need | Skill |
|---|---|
| **Build + restart server** | **.claude/skills/build-and-run.md** |
| First-time setup | .claude/skills/replit-setup.md |
| Feature planning | .claude/skills/feature-planner.md |
| Data fetch and cache | .claude/skills/data-architecture.md |
| Options chain fetch | .claude/skills/options-pricer.md |
| RSI/MFI/filter logic | .claude/skills/signal-filters.md |
| UI components | .claude/skills/ui-components.md |
| DB schema and queries | .claude/skills/db-patterns.md |
| Trader strategy/scoring | .claude/skills/trader-context.md |
| Technical scorecard | .claude/skills/technical-scorecard.md |
| End of session | .claude/skills/session-wrap.md |

## AGENTS
Full catalog + handoff protocol: `.agents/AGENTS.md`
verifier   = tsc + lint + tests after every feature (.claude/agents/verifier.md)
data-agent = data fetching, cache boilerplate (.claude/agents/data-agent.md)
ui-agent   = React components, props-driven (.claude/agents/ui-agent.md)

## CROSS-AGENT CONTEXT (git-tracked, readable by all agents — point any agent here)
Project/workflow/state: .agents/context/   (project.md, workflow.md, state.md)
Agent catalog:          .agents/AGENTS.md  (capabilities, constraints, handoff protocol)
Memory/lessons:         .agents/memory/    (MEMORY.md index)
Session history:        .agents/sessions/  (INDEX.md rolling log)

## CURRENT STATE
Next tasks + phase: `.agents/context/state.md`
Roadmap + known issues: `FILDI_ROADMAP.md`

## CODEGRAPH (use at start of every task)
  codegraph context "<task>"   — relevant files/symbols before touching anything
  codegraph impact <symbol>    — what breaks before changing a function
  codegraph callers <symbol>   — all usages before refactoring

Never read source files to understand structure — use codegraph context first.

## READING RULES
- Never use Explore agents for broad sweeps
- State file name and reason before reading
- Max 5 files per task without explicit approval
- Use find/grep to locate before reading

## SESSION LOG
Full history: `.agents/sessions/INDEX.md` (auto-updated on Stop)
Phase reports: `.claude/docs/phase-report*.md`

## HOOKS LOCATION
Hooks are in .claude/settings.local.json under the "hooks" key.
Never create .claude/hooks/hooks.json — that file is not read.
