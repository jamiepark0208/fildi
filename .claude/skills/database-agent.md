---
name: database-agent
description: Resolve Stock DB Needs Review with cheapest accurate gold, batched local sources, agent override trails, and learning log. Use for NR drain, Stock DB mediation, override notes, purple agent cells.
---

# Database Agent

## Goal

Cut **Needs Review** (divergent ∧ ¬override) using the **cheapest accurate** source already on disk. Leave an audit trail Jamie can read in the cell popup. Purple/pink cell = agent override.

**A round is not done until VERIFY grades the overrides.** Count Δ alone is not success.

## Non-goals

- Not a second gold writer — still `manual_overrides` → `resolveField` → `field_provenance` / `ticker_fundamentals`.
- Do **not** live-call Yahoo/FMP/AV for a NR round. Bronze is already in `source_fundamentals`.
- FactSet live drain = budgeted `--factset` on skips / `drain-needs-review.ts`.
- Web scraping = last resort, rare, log why.

## Cost ladder

```
local research (WRDS finratio, LSEG gold_audit)  →  $0
yahoo / edgar / finnhub / polygon (bronze)       →  already paid
alpha_vantage / fmp                              →  scarce bronze
factset (cached silver, then live referee)       →  scarce
schwab                                           →  quotes only (not ratio gold)
web                                              →  avoid
```

## Decision rules (`lib/database-agent-resolve.ts`)

1. Cluster free bronze (~15% rel). Majority (≥2) → **cheapest in cluster**.
2. Edgar-secondary fields (`grossProfit`, shares, …): drop edgar when a TTM/primary exists.
3. ≥3 free quotes: drop ≥3× scale outliers vs cheapest.
4. WRDS/LSEG confirms / nearest free.
5. **FactSet before derived** (ALAB).
6. Derived P/B uses **FactSet equity when present**, else gold equity (AAOI lesson).
7. Else **skip** → `--factset` batch → re-decide.

## Trail (required)

```
agent:v1|chose=yahoo|val=5.4|reason=majority_cheap|cluster=yahoo:5.4,finnhub:5.35|skip=av:8.78|research=wrds:5.3
```

Grid: fuchsia `agent_override_flags`. Popup: Agent trail + WRDS/LSEG/Schwab.

## Run a round (~10–20) — with checks

```bash
cd artifacts/api-server
pnpm exec tsx src/scripts/database-agent-resolve-nr.ts --limit=18 --dry-run   # peek
pnpm exec tsx src/scripts/database-agent-resolve-nr.ts --limit=18 --factset  # apply
pnpm exec tsx src/scripts/database-agent-verify.ts                          # REQUIRED
# exit 1 if any FAIL — reopen bad locks:
pnpm exec tsx src/scripts/database-agent-verify.ts --reopen-fails
```

Batched: one SF load, one WRDS, one LSEG. FactSet only on `--factset` for skips.

## Verify grades (`lib/database-agent-verify.ts`)

| Grade | Meaning |
|---|---|
| **PASS** | FactSet within 20% of gold, or `primary_vs_edgar`=yahoo, or ≥2 free agree within 15% |
| **WARN** | Weak consensus / sign flip / no FactSet — keep, watch |
| **FAIL** | FactSet fights gold, or derived P/B used contested equity — **reopen** |

Report → `.agents/context/database-agent-log.md`. Skill/rules update only when a FAIL teaches a new heuristic (with evidence).

## Accountability UI

1. Fuchsia cell → click → **Agent trail** (chose/val/reason/cluster/research).
2. Research/desk rows show WRDS/LSEG values when mapped.
3. VERIFY report in log — Jamie (or next agent) reads PASS/WARN/FAIL before another round.

## Continuous learning loop

1. Run round → VERIFY.
2. Every FAIL → `--reopen-fails` + write a **Lesson** in the log (what lied, what rule changes).
3. Encode the lesson in `decideNeedsReview` / derive inputs + a unit test (like AAOI equity, ALAB FS-before-derived).
4. Do **not** raise NR “resolved” counts that include unreopened FAILs.

## Tests that matter

- `database-agent-resolve.test.ts` — decision paths
- `database-agent-verify.test.ts` — PASS/FAIL grading (AAOI FAIL fixture)

## Related

- `.agents/context/stock-db-best-realistic.md`
- `.agents/context/database-agent-log.md`
- `drain-needs-review.ts`
