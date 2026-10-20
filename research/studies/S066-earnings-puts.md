# S066 — Should weekly puts be blocked across earnings?
2026-10-20 · Claude · **Interim FAIL → block stays** (58/248 names) · `scripts/watchlist_sync/analysis/s066_earnings_puts.py` · report `scripts/watchlist_sync/out/opt/S066.md`

## Question
89 names were blocked from weekly puts in the week of 10-20 because earnings fall before expiry. S018 says earnings IV is ~1.5× overpriced.
Is the block costing money?

## Data
- Report dates: `lseg_research.earnings_moves` (true LSEG dates, A114), Tue–Thu reports only (Mon/Fri timing is ambiguous for a Mon→Fri weekly), 2021 →.
- Real option quotes: LSEG daily bid/ask (`research/lseg/option_prices.history`, cached in `optlab.lseg_opt_daily`).
- Capped at 3k LSEG requests per run (of the 10k/day budget). Tickers run in random order (seed 66), so a capped run is a random sample of names.

## Method
- Earnings arm: sell the weekly put expiring Friday of the report week, entry = first session of that week.
  Strike nearest 0.20Δ with σ covering the event the way a live chain does (variance = IV30²·T + m², m = median |move| of the previous ≤ 8 reports).
- Normal arm: same name, a random Mon→Fri week with no report within ±10 days, 0.20Δ at IV30.
- Fill = bid + 23 % of spread (A206); exit = intrinsic at Friday close. pnl per $ collateral; ITM = finished below strike.
- Pass (plan §4, pre-registered): earnings pnl ≥ normal AND ITM ≤ normal + 2 pp, both before and after 2024-07.

## Result (interim, 58 names)
| slice | earnings n | pnl | ITM | worst 10 % | normal n | pnl | ITM | worst 10 % | p(earn ≤ normal) |
|---|---|---|---|---|---|---|---|---|---|
| < 2024-07 | 285 | +0.14 % | 26 % | −9.4 % | 259 | −0.02 % | 22 % | −5.8 % | 0.28 |
| ≥ 2024-07 | 236 | +0.39 % | 24 % | −9.1 % | 269 | −0.17 % | 22 % | −7.5 % | 0.05 |

## Verdict (interim)
Earnings weeks pay more (+0.25 % vs −0.09 % per trade), but they finish in the money 2–4 pp more often and the worst decile is ~2.6 pp worse.
That fails the pre-registered risk condition, so the block stays. If the final run holds, the honest framing is "more income, more assignments":
a size-down warning is the candidate. A hard block is the cautious choice.
Side finding: normal-week 0.20Δ puts lose slightly after fills, consistent with S059 (weekly puts need put edge Q4+).

## Known weaknesses
1. Interim sample (58 names); final verdict after ~3 more daily runs (each re-run continues from cache).
2. The strike σ uses the median past move, not the live chain's earnings IV. That's close to how a live 0.20Δ pick behaves, but not identical.
3. No IV-fixed control between arms yet (earnings weeks have higher IV by construction); the comparison is on the decision (sell or not), which is the intended use.
4. 1,929 of 3,002 requests were contract misses (strike-ladder guesses). That's budget waste, not bias.

## Re-run
`cd research/lseg && .venv/bin/python ../../scripts/watchlist_sync/analysis/s066_earnings_puts.py` (daily until every name is cached) · smoke `--tickers=MU,SHOP,CAVA`.
