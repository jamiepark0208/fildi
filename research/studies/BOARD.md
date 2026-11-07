# Strategy board — what works, what's dead, what's testing
> Read this before proposing any test (all agents). One line per verdict; detail lives in `INDEX.md`. Update the line when a study lands. Feeds Track Record › Strategies (A368).

## Works (passed out of sample)
| Rule | Number | Study | Live? |
|---|---|---|---|
| Model List puts: top-10/wk with P(kept) ≥ 90 % | +77 bp/wk vs +35 plain 1σ; IRA puts +24.2 % vs SPY +12.2 %, DD −2.2 % | S088 · S047 | live |
| Rich-put lane: ≥ 0.9 %/wk, ≥ 10 % OTM, ≥ 25 % off high | +101 bp/wk vs +34 same weeks, t 5.7 | S109 | shadow lane |
| Panic puts: panic drop + IV30 > 48.7 | kept +4.05 % vs +0.26 %; 2025 +3.15 vs +1.63 % | S054 | live (Strategies) |
| Sharp-drop regime (SPY 3m ≤ −8 %, VIX÷VIX3M < 1) → higher put Δ | bp rises steeply with Δ, both periods | S101 | strategy_rules |
| Buy calls: rising revisions + strong 60d return | holdout +69.6 % vs revisions +43.1 % (t 2.0) | S100 | board gate |
| Calls: low volume + not stretched above 200d | +42.9 bp/wk OOS, t 4.6 | S046 | options-1.2.0 |
| Index oversold: SPY/QQQ RSI14 < 25 → long 5 d | **UNDERPOWERED** (A371): 17 / 14 events since 2003; at RSI < 30 SPY 60.9 % vs 59.0 % base (46 ev), QQQ 76 % vs 60 % (39 ev, halves 64 / 94 %) | S159 | trigger chip (A368) (label underpowered) |
| Watchlist RSI14 < 25 → buy next open, 5 d | +2.0 pp vs own avg 2019→, 242 events, up 53 % (one global cutoff) | S160 | context (pending A378 re-run: test-era centering) |
| Wide credit spreads → market-drop warning | S&P −5 % in 21 d: 25 % vs 13 % | S028 | display |
| IV ÷ RV is the put edge | t 4+ | S003 / S004 | in fit score |

## Dead — as of the date tested, not forever
Dead = don't re-run **the same test**. A variant is welcome when it names what is different (new regime, new data, new structure, fairer comparator, real costs). Kind: **cost** = gross edge smaller than the spread (durable; re-check only if costs or fills change) · **no-lift** = no edge in that sample (can change with regime → re-screen on the Re-check date with the newest data) · **framing?** = the test itself may be wrong (comparator, units, approximated dates) → audit (A371). `scripts/asks_revisit.py` lists due re-checks at session start.
| Idea | Why | Study | Kind | Re-check |
|---|---|---|---|---|
| Per-stock RSI cutoffs | 3–12 events per name; shrunk per-stock −0.7 pp vs global 25 out of sample | S160 | framing? (A378 centering) | after A378 |
| Intraday indicator signals (stock or options) | gross lift < spread; 0/144, 0/60, 1/221 | S152 · S155 · S156 · A362 | cost | cost |
| Short-term RSI dip entries (1m…1h), 21 names | every cell ≤ 0 after spread; best 1h RSI<30 −8.6 bp | A359 fix4 | framing? (A374/A375 engine bugs) | after A359 fix5 |
| Overnight carry | +10.8 bp/night gross, −5 mid / −21 cross → timing rule only | A359 | framing? (A374/A375 engine bugs) | after A359 fix5 |
| Put spreads / strangles / straddles vs CSP | −$17.5k / −$12.4k vs CSP on the same entries | S020 | framing? | 2026-11-07 |
| Stops, 50/75 % profit takes | −$13.7k (stop); takes lose on real quotes | S017 · S103 | no-lift | 2027-02-07 |
| Calendar / Fed / CPI / opex weeks | 0/22 | S026 | framing? | 2027-02-07 |
| Streaks, post-earnings drift, bounce after drops | 0/12; fail; no edge | S030 · S032 · S025 | no-lift | 2027-02-07 |
| Sector-specific fundamental weights | 0/6 sectors better | S024 | no-lift | 2027-05-07 |
| Recession odds model | no skill vs base rate | S029 | no-lift | 2027-05-07 |
| Tech score totals | predict nothing | S004 | no-lift | 2027-02-07 |

## Testing / queued
- A370 indicators as put-timing filters in the seller's universe (smoke 11-07: top-IV names, SuperTrend bear / below 200d / 5d drop → +1.8–2.5 vol pts IV−RV, t 4–9; RSI>70 and high-volume days −4.4; works when SPY > 200d, fades in broad sell-offs)
- S159 → short puts on index-oversold days, real chains (A359 engine)
- A365 event-stack guard (vol backwardation + earnings) vs S159 conflict
- A366 50 % take vs hold on Jamie's own book
- A369 per-stock threshold lens for every threshold signal (IV, RSI, …) in fast_screen
- Candidates: earnings-crossing calls (all names), stacked put lanes + sector cap (A352), index-vs-single-stock IV spread, credit-wide as a put size dial
