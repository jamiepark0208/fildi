---
name: feedback-reading-rules
description: Rules for how to read files efficiently — no broad sweeps, state file+reason before reading, max 5 files per task
metadata:
  type: feedback
---

Never use Explore agents for broad codebase sweeps — they read too many files and burn context.

Read files directly with the Read tool only when needed. Before reading any file, state its name and the reason. Max 5 files per task without explicit user approval. Use find/grep to locate files before reading them.

**Why:** User corrected this after the first plan session consumed excessive tokens via 2 broad Explore agents sweeping 50+ files.

**How to apply:** Every task, check: do I need this file? Can I grep/find first? Have I already read more than 4 files this task? If yes to the last, ask before reading more.
