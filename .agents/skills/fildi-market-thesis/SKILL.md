---
name: fildi-market-thesis
description: Test a market view (Jamie's or our own) to PhD-defensible standard — claim tree, evidence with sources, historical analogs, money flows, scenarios with odds, both sides, scored later. Use whenever Jamie shares a market/sector/stock thesis, asks "is my view right", or an earnings season / macro event needs a read — any agent.
---

# FILDI market thesis — prove or disprove, then build conviction (shared by Claude, Codex, Cursor, Muse)
Jamie 10-28: "look for ways to prove or disprove my thesis… build conviction both ways and weigh benefits/costs…
if someone asks why my views are like this, I need full PhD-level studies, not hallucination. Always consider the other side."
Worked example: `research/market-views/THESIS_2026-10-27.md` (graded "really good" by Jamie). Ledger: `research/market-views/LOG.md`.

## 0. Rules that make it defensible
1. **Every number has a source and a date** in the write-up (vendor/table/URL + as-of). No number from memory. Web numbers that
   disagree → show the range and say which source you trust. Secondary aggregators are flagged as such.
2. **Every computed number is reproducible**: a script in `research/market-views/` (or a study script) + its output file, and an
   INDEX row (S###) when it answers a question. Someone re-running it gets the same table.
3. **Both sides, tested — not a pro/con list.** Each claim gets a verdict (TRUE / HALF / FALSE / NOT YET / SPLIT) from evidence.
   Devil's advocate alone was rejected as "brute force, no real thinking" (10-28).
4. **Claude forms its own view** (LOG row `C#`) and it is scored like Jamie's. No hiding behind "it depends".
5. **Say what it changes for the put book** (usually: nothing on timing — S087/S027 — but name selection, band, caution tags).
6. **Do the analysis yourself.** Cheap studies on data we already store run inline. Cursor gets only narrow tasks: data refresh
   + one script + one table + fixed acceptance check (A293 is the template). Never "test X" rows.

## 1. Steps
1. **Restate** the view in 1 line + claim tree (≤ 10 sub-claims, each falsifiable). Keep Jamie's words in the LOG.
2. **Prior work:** `research/studies/INDEX.md`, `oj.py studies`, earlier THESIS files — reuse, don't redo.
3. **Evidence per claim** (pick what fits; § 2 has the menu). Write the verdict + the one number that decides it.
4. **History:** `research/market-views/analogs.py <shiller.xls> <fred_dir>` — conditional base rates + 12 nearest months
   (one per episode). Update the TODAY vector first. Report base rate next to every conditional (P(≥ 10 % drawdown) matters
   more than the median for a put seller). Small samples: say episodes, not months.
5. **Money flows:** who is paid by the spending — consensus revenue revisions by bucket (`research/market-views/flows.py`,
   fiscal-period matched), government budgets/stakes (CBO, budget requests, DoD/DOE/Commerce deals), capex guides.
6. **Scenarios:** 3–5 paths with odds that sum to 100, each tied to analogs + signposts that move the odds. Say they are
   judgment-weighted, not a model output.
7. **Write** `THESIS_<date>.md` (claim tree table → history → money flows → scenarios → Claude's view → put-book impact →
   sources), LOG rows (Jamie V#, Claude C#, each with "wrong if" + check date), INDEX rows for any new study.
8. **Reflect (every check date and every new THESIS):** fill LOG outcomes; once ≥ 10 scored, hit rate by view type and
   Brier on the scenario odds. Add a line to § 4 when a method misled us.

## 2. Evidence menu — earnings first (our view rests on earnings carrying the market)
| layer | signal | where |
|---|---|---|
| Index earnings | blended growth, beat rate + size, fwd EPS revisions, margins | FactSet Earnings Insight (weekly); IBES `wrds_research.ibes_statsum` (monthly, lags ~2 m); LSEG `watchlist_sync.consensus_annual` (daily from 10-27) |
| Revisions breadth | % of names revised up, by bucket / sector | `flows.py` (A293) |
| Reactions | beat/miss move vs usual move; asymmetry | `lseg_research.earnings_moves` × IBES surpsum (S120) |
| Guidance / capex | hyperscaler capex guides, RPO/backlog, book-to-bill | 10-Q/8-K, transcripts (`watchlist_sync.earnings_transcripts`) |
| Upstream (early) | TSMC monthly sales, Korea chip exports (first 20 days), DRAM/NAND prices, memory revisions | company IR / customs / LSEG econ series |
| Downstream | cloud revenue growth, AI software revenue, enterprise IT budgets | earnings, surveys |
| Macro | CPI/PCE trend, 2y/10y, Fed path, oil, HY OAS, productivity, labor share, NIPA profits | FRED CSV (no key), CME/Kalshi |
| Valuation | fwd P/E vs CAPE, earnings yield vs real yield | FactSet, Shiller, multpl |
| Positioning / flows | BofA FMS, money-fund assets, insider selling | ICI, BofA, SEC Form 4 |
| Policy / government | deficit, outlays by function, budget requests, equity stakes, price floors | CBO, CRS, agency releases |
| Prediction markets | elections, Fed, recession odds | Kalshi (`kalshi-macro.ts`) |
| Strategists | named targets + bear case, dated | press; list ≥ 3 bulls and ≥ 2 bears |

## 3. Signpost discipline
Each scenario names 2–4 signposts with a threshold and a date (e.g. 10y > 5.25 %, HY OAS > 4 %, hyperscaler capex cut, Dec FOMC hike).
When a signpost fires: update odds in a new dated section of the THESIS (never edit old numbers), and say what changed.

## 4. Lessons (append; each from a real miss)
- 10-28: IBES FY1/FY2 revisions across a fiscal-year end look like +85 % (NVDA). Match on identical `fpedats` at both dates.
- 10-28: "Correction" felt by Jamie was in his themes (CRWV −61 %, SMH −19 %), not the index (SPY −2 %). Always split index vs his names.
- 10-28: Analog nearest-neighbours need one month per episode, or one era (2021) fills the list.
- 10-28: Web results disagree (capex $690–800 B; CoreWeave debt $36–52 B): show the range, cite both.
