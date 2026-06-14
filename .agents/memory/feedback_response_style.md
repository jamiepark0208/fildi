---
name: feedback_response_style
description: User wants concise responses — no echoing code/commands back, 1-2 sentence action summaries
metadata:
  type: feedback
---

Keep responses concise. Never echo back code you just wrote or commands you just ran — the user can see tool output directly.

**Why:** Long code blocks and verbatim command output consume context unnecessarily and add noise the user didn't ask for.

**How to apply:**
- State what you did in 1-2 plain English sentences per action
- No multi-line code blocks in prose unless the user explicitly asks to see the code
- No repeating file paths, command flags, or output verbatim in text responses
- Phase/checkpoint summaries: one sentence per item, table format if multiple results
- Tool output (tsc results, curl responses, build output) can be quoted briefly inline, not in a full code block
