# Theme sources — who we read to find themes (Jamie 10-28: "have a group of people you follow … then verify yourself")

Purpose: find themes we are missing (10-27 thesis missed geopolitics). Sources nominate themes; **our data decides** (fildi-market-thesis §5).
Monthly sweep (A296): read the latest public piece from each source → `theme_sweeps/<YYYY-MM>.md` (source × theme table). A theme named by
≥ 3 independent sources, or by one tier-1 source with a checkable mechanism, and not in `themes.json` → Claude writes signposts from our data
or says why it can't be measured. Explicit, checkable calls (a level, a date) → `figure_views` (A85) so the caller gets a Brier score.
Consensus is information, not truth: when every source names the same risk, note it as crowded (BofA FMS "most crowded trade").

| tier | source | what to take | cadence | public at |
|---|---|---|---|---|
| 1 | BlackRock Investment Institute (incl. Rick Rieder, fixed income) | weekly themes, outlook "mega forces", rates view | weekly · Dec outlook · Jul midyear | blackrock.com/corporate/insights/blackrock-investment-institute |
| 1 | Bridgewater (Dalio's former firm) research | regime framing: growth × inflation, debt cycle, geopolitics | ad hoc | bridgewater.com/research-and-insights |
| 1 | Federal Reserve: FOMC minutes, Financial Stability Report (survey of salient risks), Beige Book | official risk list + regional anecdotes | 8×/yr · 2×/yr · 8×/yr | federalreserve.gov |
| 1 | BofA Global Fund Manager Survey (via press) | biggest tail risk, most crowded trade, cash level | monthly (mid-month) | press coverage (Reuters, Bloomberg, CNBC) |
| 1 | JPMorgan Guide to the Markets · Michael Cembalest "Eye on the Market" | earnings, valuation, energy/AI deep dives | quarterly · monthly | am.jpmorgan.com |
| 1 | Apollo — Torsten Slok "Daily Spark" | one chart a day: credit, AI capex financing, labor | daily | apolloacademy.com |
| 2 | Goldman Sachs Insights / "Top of Mind" | one theme per issue, bulls and bears both interviewed | ~monthly | goldmansachs.com/insights |
| 2 | Morgan Stanley "Thoughts on the Market" | strategist views incl. Wilson (equities) | daily podcast | morganstanley.com/insights/podcasts |
| 2 | Oaktree — Howard Marks memos | cycle position, credit, risk appetite | ~quarterly | oaktreecapital.com/insights |
| 2 | GMO quarterly letter | valuation / bubble framing (bear-case anchor) | quarterly | gmo.com |
| 2 | IMF World Economic Outlook / Global Financial Stability Report | global growth, sovereign debt, financial stability | Apr · Oct | imf.org |
| 2 | Eurasia Group Top Risks | geopolitical risk list for the year | January | eurasiagroup.net |
| 3 | Yardeni Research, Fundstrat (Tom Lee) public notes | explicit S&P targets (already A85 figures) | weekly | yardeni.com · fundstrat.com |
| data | Caldara–Iacoviello Geopolitical Risk index | daily geopolitics level (in themes: `gpr_*`) | daily | matteoiacoviello.com/gpr.htm |
| data | Kalshi / Polymarket | event odds (elections, Fed, conflicts) | live | kalshi.com |

Balance rule: each sweep lists ≥ 3 bulls and ≥ 2 bears on the index (skill §2); GMO / Marks are the standing skeptics.
