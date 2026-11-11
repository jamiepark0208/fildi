# Fildi — what it must become (product north star)
> Read at session start, before picking work (CLAUDE.md startup 0). Built 11-10 from Jamie's own prompts (10-15 'what a win is', 10-18 strategy library, 10-28 key themes, 11-06 goals, 11-07 monetize + copy competitor features, 11-10 probabilistic entries). Jamie should never have to restate this. Update the gap table when a row ships.

## The job (Jamie's words, condensed)
1. **Find the win before it happens** — time relative tops/bottoms, sell deep-OTM premium (or buy calls/puts) and close early at a high annualized yield as the stock mean-reverts (10-15). Probabilities and risk-adjusted bets, not if-then rules (11-10).
2. **Any structure from a view** — bull / bear / neutral / vol × horizon × max loss → ranked structures at real fill, each with its tested evidence (11-07).
3. **One place per decision** — strategy library with rules, track record and trades (10-18); key themes like a hedge-fund year-ahead outlook, built from data Fildi already has (10-28).
4. **Better than what traders pay for today** — copy what competitors do well that Fildi lacks, then beat it with Fildi's edge (real-fill backtests, book risk, own data) (11-07). Monetizable later: licensed data, multi-user.
5. **Trusted, fast, runs without him** (11-06 goals.md).

## How Claude failed this (root cause, 11-10)
- Every session started from the ASKS / study queue and the scoreboard alarm, so product work had no slot → 7 studies in one day, zero new features.
- The 11-07 answer covered data licensing and a structure design but never produced the competitor feature list, so nothing was built from it.
- When challenged, Claude summarized and pointed to /clear instead of fixing the cause.
**Fix:** this file at startup; each session ships ≥ 1 row of the gap table (or says which blocker stopped it); studies only when a row needs one.

## Competitor gap table (Fildi status checked against code 11-10)
| # | Feature | Who sells it | Fildi today | Value for a premium seller | Data we already have | Priority |
|---|---|---|---|---|---|---|
| 1 | **Roll / defend analyzer** for open short puts: roll down/out credit, new break-even, P(touch) before vs after, assignment-adjusted basis if taken | OptionStrat, tastytrade, wheel trackers | put_manage = take/re-sell/hold only; no roll candidates | The crash pain: what to do with a losing put | Schwab chains, open positions, put engine | **P1** |
| 2 | **Unusual options activity / flow** (block / sweep, vol ≫ OI, premium $) per name + market | Unusual Whales, Barchart, Cheddar Flow | **have** (A396 11-10): Breakdown + Feed › Options flow, prints ≥ $25k, × own median, blocks, bursts, vol/OI; side unknown (no bid/ask) | Confirms or warns before selling into a name | LSE OPRA trades since 10/2025 (paid for, mostly unused) | **P1** |
| 3 | **Earnings move history**: implied vs realized move per past quarter, IV crush, post-ER drift | Market Chameleon, ORATS | earnings-history-section (EPS); implied move only on the chart | ~45 % of missed trades are earnings (eod_audit) | earnings dates, daily bars, iv30 history | P2 |
| 4 | **Trade journal + grade** (Jamie 11-10: wants it, needs a UI home → A393 building): every fill auto-imported, tagged by setup, P&L vs what Fildi said that day | TraderSync, Tradervue, Edgewonk | rec_scoreboard.py (CLI only) | Learns Jamie's real edge (RGTI/ONDS wins) | portfolio_orders, put_recs_daily | P2 |
| 5 | **Probability cone + expected-move bands** on the price chart, strike markers for open/candidate puts | thinkorswim, tastytrade | **have** (11-10, 1f16c9b5): forward ±1σ/±2σ cone on daily charts + strike lines with σ · % ITM (live quote), engine candidate puts teal; Playwright-checked 11-11 (959d0a14) | See distance to strike in σ at a glance | iv30, chains | P2 |
| 6 | **Congress trades** (Jamie 11-10: 'pretty interesting') + insider/13F | Quiver, Unusual Whales | insider panel; congress → A394 building (FMP senate/house endpoints work on our key) | Context; untested edge, 30–45 d disclosure lag | FMP stable senate/house; EDGAR Form 4 | P2 |
| 7 | **Dealer gamma (GEX) by strike** for SPY/QQQ + big names | SpotGamma, UW | SqueezeMetrics index line only | Index momentum vs reversal days (Baltussen 2021) | Schwab chains OI × gamma | P3 |
| — | Legs builder + payoff | OptionStrat | **have** (StructureBuilder, A192 L) | — | — | done |
| — | Book Monte Carlo, VaR, assignment flag | (rare in retail) | **have** (PM Alerts) | Fildi's edge — keep | — | done |
| — | Strategy library w/ track record | Option Alpha, Composer | **have** (Track Record › Strategies) | — | — | done |

## Data cautions (Jamie)
- **tastytrade:** account unfunded → data may be poor. 11-10: IV percentile vs LSEG corr 0.70, 11 % of names off > 30 pts → removed from the IV-rank resolver (iv_rank.py, FILDI_TASTY_IVRANK=1 to re-enable) and the API reader. Liquidity rating still display-only — don't build on it.

## Build order
Built 11-10: #1 (A392), #4 (A393), #6 (A394), #2 (A396), #3 (earnings implied vs actual for ~900 names via IV30 crush, calibrated 0.9× real straddles; Breakdown › Options), #5 (cone + strike odds). Next #7 GEX by strike. One row per session, end to end (API + UI + Playwright check + scoreboard/eval line). Each row's spec lives in its ASKS file; this table keeps the status.
