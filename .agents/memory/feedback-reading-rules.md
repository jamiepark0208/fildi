---
name: feedback-reading-rules
description: Codegraph-first rule + file reading discipline to prevent context blowout on session start
metadata:
  type: feedback
---

## Codegraph FIRST — always, before any file read

Use `codegraph_context("<task>")` as the FIRST tool call on any non-trivial task. It returns symbols, callers, and callees in one call without putting raw file content into context. Then use `codegraph_explore` or `codegraph_node` for the specific symbols surfaced. Only fall back to `Read` for details codegraph couldn't surface.

Never open a file just to "understand the shape" — codegraph already has it indexed.

**Why:** Reading 5+ large files on the first prompt consumed ~30% of context before any work was done. Codegraph answers the same structural questions in 3-5 targeted calls that cost a fraction of the tokens.

**How to apply:**
1. `codegraph_context("<task description>")` → identifies relevant symbols
2. `codegraph_explore` or `codegraph_node` on the 1-3 most relevant ones
3. `Read` only for details codegraph missed (specific logic, comments, test cases)
4. Hard limit: max 3 full-file reads per task without user approval
5. Never read options-scanner.tsx, technical-rankings.ts, or technicals-db.ts in full — they are 500-1000 lines each; use codegraph_node for specific functions

## File reading discipline (unchanged)

Never use Explore agents for broad codebase sweeps — they read too many files and burn context.

Before reading any file, state its name and the reason. Use find/grep to locate symbols before reading whole files. If a grep result answers the question, don't open the file.

**Why:** User corrected this after the first plan session consumed excessive tokens via 2 broad Explore agents sweeping 50+ files. Repeated on 2026-06-16: read 7 large files in parallel on first prompt, hit 48% context.
