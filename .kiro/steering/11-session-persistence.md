# Session Persistence
> Track work across git commits and new sessions

## Session Start Protocol

**When Kiro starts new session:**
1. Read `.agents/context/state.md` - current phase
2. Check `.agents/tasks/` for `in-progress (Kiro)` tasks
3. If exists → resume that task
4. If not → pick new task from "Next tasks"

## Session Logging

**Create session log**: `.kiro/sessions/YYYY-MM-DD-HHMM.md`
```markdown
# Kiro Session YYYY-MM-DD HH:MM

**Phase**: [from .agents/context/state.md]
**Task**: [task being worked on]
**Files changed**: [list]
**Completion status**: [done/blocked/partial]
**Next session should**: [resume/start new]
```

## Cross-Session Context

**Before ending session**:
1. Update `.agents/tasks/` file STATUS
2. Write session log
3. Ensure all changes committed/pushed

**Next session reads**:
1. Latest session log
2. Task STATUS
3. Git history for actual changes

## Context Management

**Never rely on memory between sessions**
**Always read from tracked sources**:
- `.agents/tasks/` (git-tracked)
- `.agents/context/` (git-tracked)
- `.kiro/sessions/` (Kiro logs)
- Git diff for actual code changes