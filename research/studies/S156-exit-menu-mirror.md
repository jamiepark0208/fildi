# S156 — exit menu, and the other side of the option trades
2026-11-06 · FAIL (after known-at fix) · `research/studies/scripts/s156_exit_menu.py` · `out/S156/cells.json`

## Question
S153 says UT/ST/MSO mark swing starts, and the round trip lost because the exit was the next flip. Does another exit, or the short side of S155/S152, make money net of cost?

## Data
Stock: Yahoo 5m via `fetchIntradayHistory` (same call as S153), 61 `indicator_events` names, 2026-09-09 → 2026-11-06, 41 sessions, 40,340 UT/ST/MSO 5m signals. Cost 2 bp/side.
S155 mirror: Polygon minute prints already cached (68 priced ticker-days). No new vendor calls. No NBBO in that cache, so spread = the minute's high−low (median 2.4% of premium on minutes that have a range); half of that per side. Flat minutes use the median.
S152 mirror: `credit_vertical` in `option_pricing.py`, same strikes as the debit vertical, RH fill mid±0.54×spread, BS exit. 18,282 graded events, 2026-10-08 → 11-05, `optlab.bars_5m`.

## Method
Entries with the signal, and the fade (brackets re-simulated; the flip exit shares the signal's exit bar). Filters: unfiltered, first hour, 5m+15m agree, SPY+QQQ agree.
**Known-at (A353 revise):** `indicator_events.time` is bar OPEN. 15m known = t15+900s; 5m entry known = sec+300s; require t15+900 ≤ sec+300 and ≤3 × 5m bars. Entry price = signal bar close. Unit test: 09:30 15m vs 09:35 5m → reject.
Exits: next flip, ATR target/stop 1/1, 2/1, 3/1.5, trail 1.5 ATR, 30m, 60m, close, chandelier 3 ATR.
Comparator: same exit on a vol-matched random bar, same ticker-day, same direction (5 draws). S155 comparator: same contracts, 5–30 min after the signal. Credit comparator: same, 8 draws.
Pass: lift > 0, own net > 0, Holm p < 0.05, both date halves > 0, ≥ 30 ticker-days, and the same after dropping the ticker with the largest lift sum. Holm is over the 144 pre-registered cells (72 stock + 36 S155 + 36 credit). A one-trade-per-ticker-day-side book is Holmed on its own 72 cells, not inside the 144.

## Result (post known-at)
**0/144 pass on the pre-registered book.** The prior 9 tf15×with passes were look-ahead: a 09:30 15m stamp (known 09:45) was wrongly pairing with 09:35 5m entries.

Old edge survival (tf15 × chandelier × with, main book): n 4942 → 763 (15% of trades kept); lift +0.28 → **−0.066** (none of the +0.28 lift survives; sign flips). Best remaining tf15×with cell is trail 1.5 ATR, lift +0.005, t 0.15, Holm 1.

Highest-lift main stock cells still fail own-net>0 (e.g. tf15×close×fade lift +0.274 but net −0.005). Unfiltered flip-with still loses (net −0.045%, lift −0.022).
Option mirrors unchanged in substance: best powered short-against (ichimoku 60m) lift +2.0%, Holm 1, net −3.6%. Best powered credit (ST 1h 60m) lift +3.6, Holm 0.52, net −5.4%. 14 thin cells (LSH, MDE ~17 pp).

Secondary first-signal book (not in the 144): 24/72 pass, mostly open×fade and tf15×fade (best tf15×close×fade net +0.043%, lift +0.30). Not a pass on the pre-registered menu.

## Verdict
FAIL. The tradable 5m+15m agree filter does not carry a with-signal exit edge once timestamps are known-at correct. S153's `5m+15m_same_side` used `|Δi5|≤3` (same leak class) — its 3.0× lift is not a tradable claim without a known-at re-grade.

## Decision
Nothing promoted. Do not use the prior S156 "9 passes" packet.

## Caveats
Holm on stacked exits still overstates independence if any cell had passed. Option spread = print range. Credit exits = BS mids.

Re-run: `scripts/watchlist_sync/.venv/bin/python research/studies/scripts/s156_exit_menu.py`
Unit: `cd research/studies/scripts && …/python -m unittest test_s156_exit_menu`
