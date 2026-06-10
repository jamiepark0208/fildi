---
name: session-wrap
description: Run at end of every session. Saves state so next session starts instantly.
---
## At the start of next session — run these first
```bash
codegraph sync
codegraph status
codegraph context "<paste the next task here>"
```

## Run this command (fill in your actual values)
```bash
node .claude/scripts/session-wrap.js \
  --phase "scaffold" \
  --working "comma,separated,done,features" \
  --progress "what is in progress now" \
  --blocked "any blockers" \
  --next "what to do next session" \
  --note "one sentence summary of today"
```
## Then git commit
```bash
git add -A && git commit -m "chore: session checkpoint — [brief note]"
```
## Keep instincts short (add to state.json instincts array)
  Each entry under 20 words. Only patterns worth remembering across sessions.
