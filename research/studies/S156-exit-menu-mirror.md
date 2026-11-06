# S156 — exit menu, and the other side of the option trades
2026-11-06 · PASS stock / FAIL options · `research/studies/scripts/s156_exit_menu.py` · `out/S156/cells.json`

## Question
S153 says UT/ST/MSO mark swing starts, and the round trip lost because the exit was the next flip. Does another exit, or the short side of S155/S152, make money net of cost?

## Data
Stock: Yahoo 5m via `fetchIntradayHistory` (same call as S153), 61 `indicator_events` names, 2026-09-09 → 2026-11-06, 41 sessions, 40,340 UT/ST/MSO 5m signals. Cost 2 bp/side.
S155 mirror: Polygon minute prints already cached (68 priced ticker-days). No new vendor calls. No NBBO in that cache, so spread = the minute's high−low (median 2.4% of premium on minutes that have a range); half of that per side. Flat minutes use the median.
S152 mirror: `credit_vertical` in `option_pricing.py`, same strikes as the debit vertical, RH fill mid±0.54×spread, BS exit. 18,282 graded events, 2026-10-08 → 11-05, `optlab.bars_5m`.

## Method
Entries with the signal, and the fade (brackets re-simulated; the flip exit shares the signal's exit bar). Filters: unfiltered, first hour, 5m+15m agree, SPY+QQQ agree. Agree counts only a signal whose timestamp is already ≤ the entry. S153's ± window looks 10–15m ahead and is not a tradable entry.
Exits: next flip, ATR target/stop 1/1, 2/1, 3/1.5, trail 1.5 ATR, 30m, 60m, close, chandelier 3 ATR.
Comparator: same exit on a vol-matched random bar, same ticker-day, same direction (5 draws). S155 comparator: same contracts, 5–30 min after the signal. Credit comparator: same, 8 draws.
Pass: lift > 0, own net > 0, Holm p < 0.05, both date halves > 0, ≥ 30 ticker-days, and the same after dropping the ticker with the largest lift sum. Holm is over the 144 pre-registered cells (72 stock + 36 S155 + 36 credit). A one-trade-per-ticker-day-side book is Holmed on its own 72 cells, not inside the 144.

## Result
9/144 pass. All nine are "5m and 15m agree, trade with the signal." The exit barely matters.

| Cell | n | ticker-days | net % | win | worst day | lift | t | calendar t | Holm |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| chandelier 3 ATR | 4942 | 2155 | +0.26 | 50% | −0.42 | +0.28 | 10.6 | 5.6 | ~0 |
| 60m | 4942 | 2155 | +0.23 | 58% | −0.58 | +0.27 | 11.4 | 6.7 | ~0 |
| to close | 4942 | 2155 | +0.32 | 56% | −0.34 | +0.26 | 9.3 | 3.7 | ~0 |
| next flip | 4942 | 2155 | +0.24 | 52% | −0.21 | +0.25 | 10.6 | 6.6 | ~0 |
| 30m | 4942 | 2155 | +0.20 | 59% | −0.66 | +0.21 | 11.3 | 5.6 | ~0 |

Halves for the chandelier cell +0.19 / +0.37. Dropping SECZ leaves lift +0.27. Worst single name-day on that cell is −3.8%; hold-to-close's worst name-day is −11.2%.
One signal per ticker-day-side (n 3157): the flip is the best of the nine (net +0.17%, lift +0.20, t 7.3, calendar t 4.9, worst day −0.47%, worst name-day −5.5%). Still passes its own Holm. Chandelier does not beat the flip once duplicate signals are removed.

## Verdict
The entry filter carries the result. The flip was throwing the trade away only on unfiltered signals (net −0.045%, lift −0.022, t −3.2, Holm 0.11). With 5m and 15m already agreed, the flip itself is about +17 bp net on the first signal of that side. Open-hour and SPY+QQQ filters do not clear a positive net.
Option mirrors do not. Best powered short-against cell (ichimoku, 60m, 52 days) lift +2.0% vs a later entry, t 1.9, Holm 1, net −3.6% after the print-range cost. Best powered credit vertical (ST, 1h, 60m, 45 days) lift +3.6, t 2.8, Holm 0.44, net −5.4% of risk. 14 cells have under 30 ticker-days (LSH slices, n_days 1–3, MDE about 17 pp). None of those are the stock rule.

## Decision
Nothing promoted. One 60-day window is not a score change. Re-test the 5m+15m stock rule on the next 60 sessions before it touches a live exit.

## Caveats
Nine passing exits are the same entries; Holm treats them as independent, so "9 passes" is one finding. Ticker-day t ignores names moving together; the calendar-day t is the number to quote (5.6 on the best stacked cell, 4.9 on the deduped flip). Worst day in the table is the average name that day, not the worst name. Spread on the option mirror is a print range, not a quote. Credit exits are Black-Scholes mids, the same limit S152 had.

Re-run: `scripts/watchlist_sync/.venv/bin/python research/studies/scripts/s156_exit_menu.py`
