# Cross-Agent Coordination
> Integrating Kiro into existing multi-agent framework

## Existing Framework (Read from .agents/)
- **AGENTS.md**: Defines roles, handoff protocols
- **tasks/**: Shared task tracking (YYYY-MM-DD-feature.md)
- **context/**: Project state, workflow rules
- **memory/**: Technical lessons

## Kiro's Integration

**Follow existing patterns:**
- Use task template from `.agents/tasks/README.md`
- Check STATUS before starting work
- Update STATUS when done/blocked
- Read `.agents/context/state.md` for current phase

**Task assignment flow:**
1. Check `.agents/context/state.md` - "Next tasks"
2. Pick task Kiro can own (UI components, route stubs)
3. Create task file with STATUS: `in-progress (Kiro)`
4. Work, then STATUS: `done (Kiro)` or `blocked`

## Communication Channels

**Safe (Kiro can use):**
- `.agents/tasks/` - task status updates
- `.agents/context/` - read project state
- `.agents/memory/` - read lessons

**Unsafe (Kiro avoids):**
- `.claude/` - Claude's internal state
- Server control - Claude's responsibility
- Git operations - coordinated through Claude

## Improvement Opportunities

**Add to existing framework:**
1. **Code reuse tracking** - `.agents/patterns/` for reusable code
2. **Similar task detection** - check memory before starting
3. **Token usage logging** - `.agents/metrics/` for optimization

**Implement gradually without breaking existing workflows**