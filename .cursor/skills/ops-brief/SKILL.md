# Ops brief (on-demand)

Narrate **existing** ops proof JSON into a short status. No exploration agents, no new ledger, no auto-fix.

Invoke when the user says `/ops-brief`, “ops brief”, or “what did Maintain/Remediate do?”

## Sources (read only)

| File | Role |
|---|---|
| `/tmp/fildi-logs/ops-remediate-last.json` | Alert Δ + whitelist actions |
| `/tmp/fildi-logs/maintain-last.json` (and `maintain-full-last.json` if present) | Heal/enrich actions, processOk |
| `.cursor/context/data-ops-value-log.md` (last entry only) | Weekly IMPROVED / NO MATERIAL CHANGE |
| Latest under `.cursor/context/ai-workflow-reviews/` (`*-verify.json` preferred) | Token `--verify` proof |

Optional live: `GET /api/admin/scheduled-tasks` `summary` + `alerts` (if API is up) — still narration only.

## Template buckets

Map each open issue / last action into exactly one:

- **AUTO_FIXED** — remediate/maintain `value: IMPROVED`, or heal `process_healed` / previously failing action now `exit_0`
- **NO_MATERIAL_CHANGE** — remediate/value-log `NO MATERIAL CHANGE`, or heal with stack already OK
- **NEEDS_YOU** — Duo / Schwab OAuth / research Workspace / score approvals / anything outside remediate whitelist; or remediate `NEEDS_YOU` / `FAILED` with sticky alerts

## Steps

1. Prefer the script (deterministic):  
   `node .cursor/scripts/ops-brief.mjs`  
   Paste or paraphrase its stdout — do not invent metrics.
2. If a file is missing, say `missing` for that section — do not guess.
3. Do **not** spawn Maintain/Remediate unless the user asks to fix something listed under NEEDS_YOU / AUTO path.

## Anti-patterns

- Codegraph/Explore sweeps “to understand ops”
- Claiming value from vibe or ideation counts
- Building a second dashboard or chat-only ledger
