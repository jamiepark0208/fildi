# .agents/claims/ — task claim files (see .agents/AGENT_OPS.md §3)

Claim a task: write `<slug>.json` = `{"agent": "...", "task": "...", "claimed_at": "<ISO>", "heartbeat_at": "<ISO>"}`.
Before starting work: check this dir — live claim (heartbeat < 2h) means hands off.
Refresh heartbeat hourly; delete on ship. Stale >2h = dead, anyone may take over.
