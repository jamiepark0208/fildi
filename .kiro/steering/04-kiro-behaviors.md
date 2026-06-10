# Kiro Behaviors — Prompt Discipline & Efficiency
> Kiro-specific rules. Auto-loaded on every prompt. Apply these before executing any task.

## Prompt compression — do this before executing

Before starting any multi-step task, compress the plan:
1. State the goal in one sentence
2. List only the files you will touch (not files you might read)
3. State the first action only — don't plan all steps upfront
4. Execute step 1, verify it worked, then plan step 2

**Bad:** "I'll read the routes file, then check the component, then look at the DB schema, then add the endpoint, then update the UI, then rebuild the server..."
**Good:** "Goal: add PUT /api/watchlist/:ticker/tag. Step 1: check api-endpoints.md for conflicts."

This matters because Kiro holds the full plan in context — long plans consume tokens on every subsequent prompt in the session.

## What to ignore — never read or index these

These paths are noisy and never contain the code you need:

```
node_modules/
dist/
.next/
build/
coverage/
*.map
*.lock
*.log
/tmp/
artifacts/api-server/dist/
artifacts/stock-compare/dist/
.codegraph/          ← codegraph index, not human-readable
```

If Kiro's file search or autocomplete surfaces files from these paths, ignore them. The actual source is always under `artifacts/api-server/src/` or `artifacts/stock-compare/src/`.

## Code review workflow (Kiro's equivalent of cubic-code-review)

Kiro doesn't have a code review plugin, but apply this checklist before marking any task done:

**TypeScript / build safety:**
- [ ] No `any` types added without a comment explaining why
- [ ] All new props have explicit types — no implicit inference on component boundaries
- [ ] Run mental build check: would `tsc --noEmit` pass? If unsure, note it for verifier

**API changes:**
- [ ] New route added to `.agents/context/api-endpoints.md`
- [ ] Route declared before any existing wildcard routes in the same file
- [ ] Backend rebuilt after any `src/` change (see rebuild command in 02-workflow.md)

**Data safety:**
- [ ] No string interpolation in SQL
- [ ] No `DELETE + INSERT` — used `ON CONFLICT DO UPDATE`
- [ ] No new external API calls without cache-first check

**UI safety:**
- [ ] No data fetching inside the component — props only
- [ ] Component file under 150 lines
- [ ] No new layout restructuring

**Handoff:**
- [ ] Wrote `.agents/tasks/YYYY-MM-DD-<feature>.md` with STATUS
- [ ] If API changed: flagged "needs verifier run" in task file

## Token efficiency — output rules

When responding or generating code:
- Don't re-state the task back before starting — go straight to the action
- Don't summarize what you just did after doing it — the diff is the summary
- When writing a file, write the complete file — don't show diffs unless asked
- When explaining a decision, one sentence is enough — no multi-paragraph rationale
- If a file needs only a small change, show only the changed lines + 3 lines of context, not the whole file
- Never output `console.log` debug statements in final code

## Understanding structure without codegraph

Kiro doesn't have the `codegraph` CLI that Claude Code uses. Equivalent commands:

| Codegraph command | Kiro equivalent |
|---|---|
| `codegraph context "<task>"` | `grep -rn "<keyword>" artifacts/ --include="*.ts" \| head -20` |
| `codegraph impact <symbol>` | `grep -rn "<symbol>" artifacts/ --include="*.ts"` — every hit is an impact point |
| `codegraph callers <symbol>` | same grep — all usages are callers |
| `codegraph sync` | not needed — Kiro reads source directly |

Run the grep before reading any file. If the grep returns 0 results, the symbol doesn't exist yet — safe to create. If it returns results, read those files (max 3) before touching anything.

## What Kiro owns vs. what to hand back

**Kiro handles:**
- Isolated UI components (no scorer/state wiring needed)
- Route stubs with typed request/response shapes
- Component prop interface definitions
- Parallel feature work that doesn't touch `rankings.ts` or `technical-rankings.ts`

**Hand back to Claude Code immediately if:**
- The task requires changes to `rankings.ts`, `technical-rankings.ts`, or `lib/db/schema.ts`
- A Drizzle migration is needed
- A hook or `session-wrap.js` change is needed
- The task is blocked for >15 min
- An architectural decision is needed (options design, scorer weight change)

Signal handoff by writing `.agents/tasks/YYYY-MM-DD-<feature>.md`:
```markdown
# <feature-name>
STATUS: done | blocked | needs-integration
CHANGED: [list files]
NEEDS: verifier run | scorer integration | state wiring | design decision
BLOCKER: <description if blocked>
```

## Guardrails (same as all agents)
- Never delete or overwrite `artifacts/macro-data.json` or `artifacts/macro-charts.json`
- Never modify `lib/db/schema.ts` — hand to Claude Code
- Never add npm packages without checking if existing solution works
- Never force-push to main
- Never commit `settings.local.json` or `.claude/state.json`