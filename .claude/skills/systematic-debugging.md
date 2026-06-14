---
name: systematic-debugging
description: Use for any bug, test failure, or unexpected behavior. Find root cause before attempting any fix — no exceptions.
---

## Iron Law
**NO FIXES WITHOUT ROOT CAUSE FIRST.** If you haven't completed Phase 1, you cannot propose fixes.

## Phase 1: Root Cause Investigation
1. Read error messages completely — stack traces, line numbers, error codes
2. Reproduce consistently — exact steps, every time
3. Check recent changes — git diff, new deps, config changes
4. For multi-component systems: add instrumentation at each boundary, run once to gather evidence showing WHERE it breaks
5. Trace data flow backward — where does the bad value originate?

## Phase 2: Pattern Analysis
- Find working examples of similar code in the codebase
- Compare working vs broken — list every difference, however small
- Read any reference implementation completely before applying the pattern

## Phase 3: Hypothesis and Testing
- State clearly: "I think X is root cause because Y"
- Make the SMALLEST possible change to test
- One variable at a time — don't fix multiple things at once
- Didn't work? Form NEW hypothesis. Don't stack fixes.

## Phase 4: Implementation
1. Create a failing test case first
2. Implement ONE fix for the root cause
3. Verify: test passes, no regressions
4. If fix doesn't work: return to Phase 1 with new information
5. **If 3+ fixes failed: stop and question the architecture** — don't attempt fix #4

## Red Flags — Stop and Return to Phase 1
- "Quick fix for now, investigate later"
- "Just try changing X and see"
- "It's probably X, let me fix that"
- Proposing solutions before tracing data flow
- "One more fix attempt" after 2+ failures
- Each fix reveals a new problem in a different place (architectural issue)
