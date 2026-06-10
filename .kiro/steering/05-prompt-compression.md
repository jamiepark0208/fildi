# Kiro Prompt Compression & Token Efficiency
> Auto-loaded on every prompt. Enforces minimal token usage.

## Compression Rules

**Before starting any task:**
1. State goal in ONE sentence
2. List ONLY files you will modify (not read)
3. Execute FIRST step only — don't plan all steps upfront
4. Verify step 1 worked before planning step 2

**Example compression:**
- Bad: "I'll read routes, check components, review DB schema, add endpoint, update UI, rebuild server..."
- Good: "Goal: add PUT /api/watchlist/:ticker/tag. Step 1: check api-endpoints.md for conflicts."

## Output Optimization

**Never output:**
- Task restatements before starting
- What you just did after doing it (diffs are the summary)
- Console.log debug statements in final code
- Multi-paragraph rationales for decisions (one sentence max)

**File output rules:**
- Write complete files — don't show diffs unless asked
- For small changes: show only changed lines + 3 lines context
- Code blocks only — no explanatory text around code
- No markdown formatting around code snippets

## Reading Optimization

**Before reading any file:**
1. Use `grep_search` to find relevant symbols
2. Read MAX 3 files per task
3. If grep returns 0 results → symbol doesn't exist → safe to create
4. If grep returns results → read only those files (max 3)

**File search patterns:**
- API changes: `grep_search` for route patterns first
- Component changes: `grep_search` for component names
- DB changes: hand off to Claude Code immediately

## Execution Flow

**Stepwise execution:**
1. Compress goal to one sentence
2. Use grep to find relevant code
3. Read max 3 files
4. Execute single step
5. Verify
6. Continue or stop

**If task expands:**
- Stop and re-compress
- "Goal expanded to: [new one sentence]"
- Continue stepwise

## Token Guardrails

**Context monitoring:**
- Break tasks > 3 steps into subtasks
- Use `invoke_sub_agent` for complex multi-step work
- If context > 40% → consider task too large → break down

**Loop prevention:**
- If same pattern repeats 3 times → stop and report
- "Task is looping on [pattern]. Should I continue or hand off?"

## Agent Boundaries

**Kiro owns:**
- Isolated UI components (no state wiring)
- Route stubs with typed interfaces
- Component prop definitions
- Feature work NOT touching `rankings.ts` or `technical-rankings.ts`

**Hand off immediately:**
- Changes to scoring files (`rankings.ts`, `technical-rankings.ts`)
- Drizzle migrations
- Hook changes
- Architecture decisions
- Blocked >15 minutes