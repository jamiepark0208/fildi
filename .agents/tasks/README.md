# Cross-Agent Task Tracking

Active task files for work shared across agents (Claude Code, Kiro, sub-agents).
Unlike `.claude/state.json` (local + ephemeral), these are git-tracked and visible to all agents.

## Naming
`YYYY-MM-DD-<feature-slug>.md`

## Template
```
FEATURE: <name>
STATUS: planning | in-progress | blocked | done
AGENT: <primary agent>
STARTED: <date>
SUBTASKS:
  - [ ] description — agent
BLOCKED_ON: (optional)
NOTES:
```

## Done
Move completed files to `.agents/tasks/archive/` after merging.
