# Fildi goals + weekly gap scan (Jamie 2026-11-06)
> Every agent: work serves these goals. Claude owns the weekly scan. Source: Jamie's answers 11-06 + 488 Claude prompts 10-06..11-06.

## Goals (all four matter; Claude's focus = 1, any agent can carry 2–4)
1. **Better trade ideas** — put/call picks, Model List, probabilities (0–100 confidence, not fixed buckets) that beat a random same-delta pick and T-bills.
2. **Trusted data** — every number right, whole universe covered, nothing silently dropped or excluded.
3. **Fast, stable app** — quick pages, jobs in dependency order, no API-budget retry loops.
4. **Runs without Jamie** — agents find, build, verify; Jamie decides only money/accounts/trades.

## Scoreboard (Jamie picked these two)
- **Return vs T-bill** — IRA strategy income per $ of risk vs T-bill, plus graded ideas vs random same-delta comparator (A171 scoreboard). Weekly number.
- **Time saved** — minutes Jamie spends deciding trades. Proxy until measured: count of Jamie "why didn't you / I had to guide you" prompts per week (`~/.fildi/agent-events.jsonl` prompt events) → should fall.

## Trust: Jamie distrusts all 4 areas (11-06)
Model List / put picks · scores + fair value · Live / indicators · data freshness. Each scan samples one area (rotate), checks 5 names Jamie holds or watches against an outside source, files what's wrong.

## Weekly gap scan (Claude, first session each week; autonomy = find + build + ship)
1. Read the scoreboard numbers (last week vs this week).
2. Rank gaps by goal-1 $ impact: worst-graded rec type, biggest loss Fildi called safe, area of the trust rotation, repeated Jamie complaints (prompt log).
3. Pick ONE gap, write spec with pass/fail + before/after, dispatch (Cursor/Grok), review, ship. Score changes still need the before/after shown.
4. Log: date · gap · fix · scoreboard before → after in the table below.

## Log
| Week | Gap | Fix (row/SHA) | Scoreboard before → after |
|---|---|---|---|
