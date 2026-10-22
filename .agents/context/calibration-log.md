# Calibration log — lessons every agent reads (A234 §5; Jamie 10-21)
> Prepended to every `scripts/agent-dispatch.sh` run. One line per lesson: date · what was missed · rule now. Keep it short; cut lessons that stop recurring.

## Miss rate (Claude spot-checks of Cursor packets)
| Date | Packets | Claude found what packet missed | Note |
|---|---|---|---|
| 10-21 | 10 | 1 | 27894a3: 23 % of put candidates had no earnings date |

## Lessons
- 10-21 · Packets filed for CI/tooling/display commits → only quant diffs (scores, Model List rules/plan, option pricing, backtests, market-data pipelines) get packets.
- 10-21 · Earnings/data changes: check coverage on the *Model List pool* (model_recs ∪ option_score_snapshots), not just fmp_fundamentals — 162/317 pool names aren't in it.
- 10-21 · Dates: never `new Date().toISOString().slice(0,10)` for a trading day → ET helper (`etDateKey`). Same bug class as 10-20.
- 10-21 · Priority queues with a cap: names that can never resolve (ETFs, empty vendor results) must back off, or they eat the cap daily.
- 10-21 · Vendor fields: confirm units per source before ranking (Yahoo D/E is always percent; a "> 20 → /100" guess made low-debt names 100× too levered).
- 10-21 · Shared tree: the IDE Cursor may be editing too → don't touch files listed under "Busy files" in your prompt.
