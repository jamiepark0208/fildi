# Caveman Mode - Smart Output Compression
> Intelligently compresses output while keeping you informed

## Compression Rules

**Instead of blocking output, compress intelligently:**

**Large code blocks**: Show first 10 lines + "... [truncated: 45 more lines]"

**Verbose explanations**: One sentence summary + "Details in file"

**JSON/config**: Show structure only + "... [full config applied]"

**Progress updates**: "Completed: [task]" not "I just did X then Y then Z"

## Communication Priority

**Always inform you of:**
1. What was completed
2. Files changed
3. Next steps if any
4. Blockers if any

**Never silently fail or block**

## Token Optimization

**Target**: 50-75% output reduction

**Method**: Summarize, truncate, structure - don't omit

**Example compression**:
- Before: 20 lines of code + 5 lines explanation
- After: "Updated api.ts with new endpoint (see file) + 5 key lines shown"

## Implementation

**Use this pattern**:
```
Goal: [one sentence]
Completed: [what]
Files: [list]
Changes: [key points]
Next: [if applicable]
```

**No hooks blocking execution**