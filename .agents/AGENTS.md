# Agent Catalog & Handoff Protocol

Canonical reference for all agents working on TradeDash. Read this before spawning or delegating to another agent.

## Agent Registry

| Agent | Model | Owns | Never does | Spec |
|---|---|---|---|---|
| **sonnet** (default) | claude-sonnet-4-6 | UI, API design, filter logic, debugging, orchestration | Architecture rewrites | — |
| **opus** | claude-opus-4-8 | Architecture rewrites | `/opus` flag required | — |
| **haiku** | claude-haiku-4-5 | Data scaffolding, cache boilerplate, verifier runs | Scorer logic, UI | — |
| **verifier** | haiku | tsc + lint + tests | Code fixes | `.claude/agents/verifier.md` |
| **data-agent** | haiku | Fetch wrappers, cron scaffolding | Scorer logic, UI decisions | `.claude/agents/data-agent.md` |
| **ui-agent** | sonnet | React components (props-driven) | Data fetching, API design | `.claude/agents/ui-agent.md` |
| **Kiro** | varies | Parallel feature work, code generation | Claude Code hooks, session state | `.kiro/steering/` |

## Decision Tree: Which Agent for What

```
Task involves...
├── API route + DB schema + scorer changes → sonnet (default Claude Code)
├── New React component, no data logic    → ui-agent
├── Fetch wrapper, cron, cache boilerplate → data-agent
├── Verify after any feature complete      → verifier (always)
├── Architecture decision / major refactor → opus (/opus flag)
└── Parallel UI work, not touching API     → Kiro
```

## Handoff Protocol

### Claude Code → verifier
Trigger: after every completed feature.
Input: feature name as string.
Output: structured VERIFY report (see verifier.md).
On NEEDS FIX: sonnet diagnoses, fixes, re-runs verifier.

### Claude Code → ui-agent
Trigger: isolated UI component work (no API changes needed).
Hand off: component name, props interface, design spec.
Hand back: write component to correct path, run `npm run build` to confirm no TS errors.
Output location: `artifacts/stock-compare/src/components/`

### Claude Code → data-agent
Trigger: new data source, cache wrapper, or cron scaffold needed.
Hand off: data shape description, endpoint or source URL.
Hand back: typed fetch function + cache wrapper in correct file.
Output location: `artifacts/api-server/src/`

### Kiro → Claude Code
Trigger: Kiro finishes a component or route stub.
Signal: write a task file to `.agents/tasks/YYYY-MM-DD-<feature>.md` with `STATUS: done`.
Claude Code picks up: runs verifier, integrates with scorer/state if needed.

### Any agent → escalation
If stuck for >15 min or hitting an architectural decision: stop, write current state to `.agents/tasks/`, flag STATUS as `blocked`, describe the blocker. Do not guess.

## Context Locations

| What | Where |
|---|---|
| Project architecture | `.agents/context/project.md` |
| Workflow + build rules | `.agents/context/workflow.md` |
| Current phase + tasks | `.agents/context/state.md` |
| Technical lessons | `.agents/memory/` (see MEMORY.md) |
| Active task files | `.agents/tasks/` |
| Session history | `.agents/sessions/INDEX.md` |
| Detailed skills | `.claude/skills/` |

## Guardrails (all agents)

- Never delete or overwrite `artifacts/macro-data.json` or `artifacts/macro-charts.json` — these are live data caches
- Never modify `lib/db/schema.ts` without running a Drizzle migration
- Never commit `settings.local.json` or `state.json`
- Never add a new npm package without checking if a native/existing solution works
- Never force-push to main
- Parameterized SQL only — no string interpolation
