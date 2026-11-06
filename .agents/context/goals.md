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
| 2026-11-06 | Live put recs lose money in every score tier (fit-1.4.3: T1 −1.24 % / T2 −5.34 % / T3 −3.13 %, 188 puts, 8 expiries; win 57–86 %) and rich-puts rule −573 bp/wk vs +185 promised (89 trades, CAT −2362 bp/wk looks like a units bug). Own−Avoid vol-matched −2.4 pp. | Diagnosed 11-06: selection, not market — picks −11.5 pts vs universe median in 10-16 week; score ranks backwards (T3 excess −8.3 vs T1 −3.5); 12 semi-equipment names one week; test had no comparator + 16 dupes → A352 | A352 e9cb41c9 + f/u: grade fixed; 299-wk history: champion +11.6 bp/wk vs random (223/299), cash-secured +11.8 vs T-bill; cap costs −5 avg, +47 in crash weeks → ex-ante cap study next | champion +15.3 cash vs T-bill +3.5 bp/wk |
