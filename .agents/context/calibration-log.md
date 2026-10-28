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

- 10-22 · A244 review said call/put history was 'forward-only, needs a purchase' — Polygon already serves ~2 y of option closes. Never write 'no data / must buy' without a live vendor probe (one curl) cited in the packet.
- 10-22 · Plans written before a data inventory drew 11 review findings (A244). Order now: read-only inventory (data + INDEX overlap + existing code) → plan → review.

## Review stats
- 2026-10-21 · auto · 1 reviewed · planned 0 / revise 1 / declined 0 / needs Jamie 0
- 2026-10-21 · auto · 6 reviewed · planned 1 / revise 5 / declined 0 / needs Jamie 0
- 2026-10-22 · auto · 3 reviewed · planned 1 / revise 2 / declined 0 / needs Jamie 0
- 2026-10-22 · auto · 4 reviewed · planned 2 / revise 2 / declined 0 / needs Jamie 0
- 2026-10-22 · auto · 6 reviewed · planned 5 / revise 1 / declined 0 / needs Jamie 0
- 2026-10-22 · auto · 6 reviewed · planned 2 / revise 3 / declined 0 / needs Jamie 1
- 2026-10-24 · auto · 6 reviewed · planned 3 / revise 3 / declined 0 / needs Jamie 0
- 2026-10-24 · auto · 6 reviewed · planned 4 / revise 0 / declined 1 / needs Jamie 1
- 2026-10-25 · auto · 6 reviewed · planned 6 / revise 0 / declined 0 / needs Jamie 0
- 2026-10-26 · auto · 1 reviewed · planned 1 / revise 0 / declined 0 / needs Jamie 0
- 2026-10-26 · auto · 3 reviewed · planned 3 / revise 0 / declined 0 / needs Jamie 0
- 2026-10-26 · auto · 1 reviewed · planned 1 / revise 0 / declined 0 / needs Jamie 0
- 2026-10-27 · auto · 1 reviewed · planned 0 / revise 1 / declined 0 / needs Jamie 0
- 2026-10-27 · auto · 2 reviewed · planned 1 / revise 1 / declined 0 / needs Jamie 0
- 2026-10-28 · auto · 1 reviewed · planned 1 / revise 0 / declined 0 / needs Jamie 0
