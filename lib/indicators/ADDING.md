# Adding an indicator

One file + one registry line + one `.pine`. Nothing else lists indicators; charts, the nightly grader and Settings read the registry.

1. Find the script: `https://pine-facade.tradingview.com/pine-facade/get/PUB%3B<id>/last` (id from `.../pubscripts-suggest-json?search=<name>`). Save the Pine source to `research/sources/tradingview/<name>-<author>.pine` (keep the license line).
2. Port line by line in `src/<id>.ts` on the `src/pine.ts` primitives (sma, ema, rma, stdev, linreg, pivots, ...). No paraphrase; note any Pine construct you could not port.
3. Export `def: IndicatorDef` (see `src/types.ts`): `id, label, version, source{url,author,license,pinePath}, defaults, timeframes, pane, title, compute(bars, opts) -> { series, events, view }`.
   - `events` = `{ time, side: buy|sell|neutral, kind, price (bar close), note[] }`, known at that bar's close. They feed the track record.
   - `view` = how to draw `series` (lines/hist/hlines); `chartKinds` limits which kinds become markers (`[]` = none).
4. Register: add `import { def as <id> } from "./<id>.ts"` and put `<id>` in the `INDICATORS` array in `src/index.ts` (add the id to `TvIndicatorId`).
5. Tests in `src/indicators.test.ts` run over every registered def automatically (no-look-ahead for series, markers and events; contract shape). Add a fixture test for the indicator's own quirks.
6. Bump `version` whenever logic or defaults change: the nightly grade is per (indicator, version).
7. `cd artifacts/stock-compare && npx tsc --noEmit -p . && npm test`; api-server: `cd artifacts/api-server && npx tsc --noEmit -p .`.
