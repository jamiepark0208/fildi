# Weekly Stock DB data-ops check

Token-efficient weekly (or on-demand) agent job. **Do not** re-explore the pipeline.

## READ ONLY THESE (in order)
1. `.cursor/plans/stock-db-best-realistic.md` — targets + non-interference rules
2. `.cursor/context/data-ops-value-log.md` — last value proofs (tail)
3. Run output of the check script below

Do **not** codegraph-sweep merge-trusted / enrich unless the script fails.

## Run (required)
```bash
node scripts/weekly-data-ops-check.mjs
# or smaller FactSet spend:
node scripts/weekly-data-ops-check.mjs --max=40
```

What the script does (you do not re-implement):
1. Audit scoreboard **before** (filled/total, NR, FactSet remaining)
2. `merge-trusted` (0 API — derives + provenance honesty)
3. If FactSet remaining ≥ max+20 → `drain-needs-review --max=N` (referee only, no free re-fetch)
4. **Peer health** (`peer-health-check.ts`): heal roster gaps, quarantine ETFs on deny-list, auto-classify new `fetch_fundamentals` tickers still missing a primary group; flag keyword mismatches + tiny cohorts for review
5. Audit **after**
6. Append quantified benefit to `.cursor/context/data-ops-value-log.md`

## Your job after the script
Reply to the user in this exact shape (keep short):

```
Weekly data-ops: IMPROVED | NO MATERIAL CHANGE
- Needs Review: A → B (Δ)
- P/E filled: …  PEG filled: …
- FactSet spent: N  remaining: M
- Peers: mapped X/Y · newly classified N · still unmapped N · keyword mismatches N
- Actions: …
Proof: .cursor/context/data-ops-value-log.md
Off-target vs best-realistic §1: <only if any metric misses target>
Peer review (if keyword mismatches > 0): list tickers from /tmp/fildi-logs/peer-health-last.json → flags.keywordMismatch — Reassign in Settings if wrong
```

If script exits non-zero: show the error tail; do not invent fixes across 10 files — fix the one failing step.

## Hard limits
- Never full-universe free enrich in this job
- Never exhaust FactSet (script already guards remaining ≥ max+20)
- Never start scorer unify from this skill
- Quote coverage as **filled/total** (lesson L-2026-09-28-01)
- Peer keyword mismatches are **flags only** — do not bulk-rewrite primaries; use Peer Group Reassign for confirmed errors

## Optional LaunchAgent
Weekly Sunday local afternoon:
`node /Users/jamiepark/Cursor/fildi/scripts/weekly-data-ops-check.mjs --max=40`
Then open a Cursor chat: “Run weekly data-ops skill — script already ran, summarize the value log.”
