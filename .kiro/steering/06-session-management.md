# Kiro Session Management
> Isolated tracking that doesn't disrupt other agents

## Multi-Agent Isolation
- Kiro modifies only `.kiro/` folder
- Reads `.agents/` for context
- Writes to `.agents/tasks/` for handoff
- Never touches `.claude/` files

## Session Protocol
**Start**: Read `.agents/context/state.md`, check API server
**Task selection**: Pick ONE task Kiro can own
**End**: Update task STATUS, write to `.kiro/sessions/`

## Kiro Task Boundaries
✅ Own: Isolated UI components, route stubs, prop interfaces
❌ Avoid: Scoring changes, DB migrations, architecture decisions

## Cross-Agent Channels
**Safe**: `.agents/tasks/`, `.agents/context/state.md` (read), `.agents/memory/` (read)
**Unsafe**: `.claude/`, `.git/` ops, server control

## Session Patterns
- 1-3 tasks max per session
- Single focus area (UI, API, or components)
- Clear completion criteria
- Avoid multi-area sessions