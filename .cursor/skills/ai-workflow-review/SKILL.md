# AI / Cursor workflow review (weekly)

Supervised weekly pass to cut token waste and improve agent workflows. **Not** DB retention — that is Mac Maintain.

## Command

```bash
# 1) Snapshot metrics + write report
node .cursor/scripts/ai-workflow-review.mjs

# 2) After cleanup — prove benefit (fail if hot context grew >5%)
node .cursor/scripts/ai-workflow-review.mjs --verify
```

Reports land in `.cursor/context/ai-workflow-reviews/`.

## What “helpful” means (quantified)

| Signal | Pass |
|---|---|
| `hotContextEstTokens` | Flat or down vs baseline (≤5% growth) |
| `oversizedMdCount` / lines | Prefer down |
| `skillEstTokens` | Prefer down or stable after merges |

`--verify` prints a proof line like `Saved ~N est. hot-context tokens (−X%)` and exits non-zero on regression.

## Checklist (same as script)

1. Trim `.cursor/context/session.md` + `cursor-state.md` to facts only  
2. Split/archive markdown >400 lines under `.cursor` / `.agents` / `.claude`  
3. Merge unused skills; load one skill at a time  
4. Add hooks/rules only for repeated mistakes (≥2× that week)  
5. Prefer codegraph over broad Read/Explore  
6. Re-run `--verify`
