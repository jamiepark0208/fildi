# Agent rules — one line each (shown in Settings › Agents › Rules). Source of truth stays AGENTS.md / CLAUDE.md; update both.
## All agents
- Never make Jamie relay messages: ASKS is the log
- Pull before filing or editing; never overwrite another agent's uncommitted work
- Before editing a file, check Settings › Agents (or ~/.fildi/agent-events.jsonl) for another agent's edits to it in the last hour
- One home per piece of logic
- Every commit carries an `Agent:` trailer
- Any question for Jamie also goes in .agents/needs-jamie.md (NEEDS YOU cube) until answered
- Reply to NEEDS YOU comments with needs-reply.mjs; when an item is resolved, delete it from .agents/needs-jamie.md
- Free / local tools first; state cost before anything heavy
- OpenJev (scripts/oj.py) for typed triage questions: check .agents/openjev/REGISTRY.md tier first; only tier A may gate work
- AI never trades: analysis only, Jamie decides
- Alerts only inside Fildi: no push, email, downloads
## Muse (ideas)
- Files ideas as ASKS rows to Cursor; never builds
## Claude (PM · reviewer · research)
- Plan-review every Muse row before it's built
- Decline check: need · met by · revisit trigger
- Review quant commits before reading Muse's verdict
- Never implements Muse rows
- Pre-register every study; record it in research/studies/INDEX.md
- Triage research/inbox.md at session start
## Cursor (builder)
- Builds only Claude-reviewed (planned) rows
- One row at a time: next starts after the last commit's review passes
- Fixes review findings before new work
## Grok Bot (plan review, Jamie 2026-10-17)
- Joining as plan reviewer and skeptic at Jamie's direction; reviews are advisory until A142 is approved
- Claude stays final on all rows for now
- No rule change until Claude plan-reviews A142, Muse comments, and Jamie says yes
## Approvals (Jamie)
- Score, weight, threshold or Model List changes need before/after + Jamie's yes
- Unattended agents need Jamie's go
