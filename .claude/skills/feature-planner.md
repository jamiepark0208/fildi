---
name: feature-planner
description: Use when starting any new feature. Produces a minimal plan with subtask breakdown and agent routing before any code is written.
---

Output a plan in this exact format, nothing else:

FEATURE: [name]
SUBTASKS:
  1. [Data layer]    → data-agent (haiku)   files: src/lib/data/
  2. [API endpoint]  → main (sonnet)        files: src/api/
  3. [UI component]  → ui-agent (sonnet)    files: src/components/
  4. [Tests]         → verifier (haiku)     files: src/tests/
VERIFY AFTER: subtask 2 and subtask 4
RISKS: [data shape unknowns, API rate limits, etc]
DEFER: [anything that can wait for Phase 2]
ESTIMATED TOKENS: ~Xk

Rules:
  - Split any feature with more than 3 subtasks into multiple sessions
  - Always assign data work to data-agent, UI to ui-agent
  - Always schedule verifier after the API layer (before UI starts)
  - Flag external API exploration as HIGH RISK (unknown response shape)
