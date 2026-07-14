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
## Git commit + push
The script handles this automatically — no manual git step needed.
Fallback (if script fails): `git add -A && git commit -m "chore: session checkpoint — [brief note, <=72 chars]" -m "[full note as body]"`
Keep `--note` reasonably short regardless — the script auto-truncates it to a 72-char commit
subject and a 150-char `state.json.last_session`, both of which rehydrate.js resends on EVERY
prompt (`git log --oneline` only shows the subject; last_session is stored verbatim). The full
note is never lost — it's always written untruncated to `.agents/sessions/claude-*.md` and, if
truncated, to the commit body too.
## Keep instincts short (add to state.json instincts array)
Every entry here is re-sent in full on EVERY prompt via rehydrate.js's UserPromptSubmit
hook — this is a per-turn cost, not a one-time doc cost, so it compounds hard over a session.
Budget: **~1200 chars total across the whole array** (session-wrap.js warns above 5 entries).
When adding a new instinct, consolidate into an existing entry or replace a stale one instead
of appending — don't just grow the list. Only patterns worth remembering across sessions, and
worth paying for on every single turn of every future session.
