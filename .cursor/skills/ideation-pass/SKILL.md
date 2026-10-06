# Ideation pass (on-demand only)

Human-gated brainstorm → candidates for `research/common/ASKS.md`. **Never** scheduled. **Never** auto-apply. **No** ops sub-agents.

## When to use

User asks for “ideation pass”, “what should we build next for ops/product”, or “candidates for ASKS”.

## Rules

1. Read-only exploration unless the user explicitly says to append ASKS rows.
2. Prefer extending existing homes (Maintain, Nucleus, value-log, ASKS) — do not invent parallel dashboards or ledgers.
3. Score / weight / UI polish ideas stay interactive-chat + user approve; never LaunchAgent.
4. Duo / OAuth / research Workspace never auto-remediate — candidates may say `NEEDS_YOU`.

## Steps

1. Skim recent proofs only (do not re-derive ops from scratch):
   - `/tmp/fildi-logs/maintain-last.json`
   - `/tmp/fildi-logs/ops-remediate-last.json` (if present)
   - `.cursor/context/data-ops-value-log.md` (tail)
   - Open rows in `research/common/ASKS.md`
2. Produce **≤7 candidates**, each with:
   - One-line ask
   - Home (file/route/script that already owns it)
   - Why now (tie to a proof gap or repeated chat question)
   - Suggested ASKS `from → to` if cross-tool
3. Stop. Ask whether to append any rows to ASKS. Do not write ASKS until confirmed.

## Output template

```
Candidates (not applied):
1. …
2. …

Proofs consulted: maintain-last | remediate-last | value-log | ASKS open count
```

## Anti-patterns

- Spawning Explore/data-agent fan-out for ideation
- Auto-merging ASKS or code from this skill
- Treating ideation candidate counts as “value”
