# A371 audit — local measurements only

Run: `scripts/watchlist_sync/analysis/a371_audit.py`. No LSEG/Polygon download. S109 recomputed from `optlab.lseg_opt_daily` + `lseg_research.daily_history`. CRSP cache `out/survivorship/crsp_*.csv.gz` (pulled 2026-10-06, months through 2024-11). VIX: `out/opt/s028_inputs/VIXCLS.csv`.

## Verdicts

- **Survivorship re-score (measured, thin).** Inactive `ticker_registry` names with iv30 history: +6 synth puts (`priced_by=s076_model`, 0 LSEG roots on dead names). S109 rule bp/wk +75.5 → +74.6 (t 3.2 unchanged). Pass bar t≥2 and ≥+50 bp/wk **still passes** → BOARD S109 stays Works; survivorship haircut small at this coverage (13% of 47 inactive tickers).
- **Drawdown leg raises performance-drops, not all delists.** CRSP 5xx within 366 days: 135/25,733 deep name-months (0.52%) vs 73/60,305 otherwise (0.12%), 4.3×. All-cause delist is lower when deep (3.57% vs 5.22%) because mergers and 4xx liquidations are more common off the crash. Not a put P&L.
- **S088 top-10/wk holdout replay (h=1w, P≥90%).** Model +109.8 vs LSEG quote replay +133.2 bp/wk (ratio 1.21); quote match **3%** of picks → PASS vs 0.8× bar but **underpowered on coverage**. Halves real H1 +82.6 / H2 +161.9. Haircut column ≠ exchange quotes (confirms BOARD caveat).
- **S109 regime: not only one SPY state, and not uniform.** Full sample stays positive with SPY above its 200-day (+87.4 bp/wk, t 3.8) and below it (+108.2, t 3.3), and in both breadth buckets. The middle VIX tercile is +20.0, t 0.4, in line with other puts those weeks. SPY-below from 2024-07 is −16.0 bp on 8 weeks. 2025 is +28.5, t 0.5.
- **One standard:** BOARD `## Underpowered` + parser; S159/S172/S173 moved; S159 chip labelled underpowered (A368).

## 1. Survivorship — what was measured

S109 recompute: 9,087 puts, 247 names, 2020-12-30 → 2026-10-23. Rule (≥0.9%/wk, ≥10% OTM, ≥25% off 252-day high): puts 420 · weeks 131 · +75.5 bp/wk · t +3.2 · kept 80%. Names 104.
Published S109.md was 318 puts, 118 weeks, +101.2 bp/wk, t +5.7. This run: 420 puts, 131 weeks, +75.5 bp/wk, t +3.2.
Rule names inactive in `ticker_registry`: 0. Not in registry: 2 (ASTX, PLTU).
Rule names with a CRSP delist row on/after 2020-12-01 (ticker match on the permno's last CRSP ticker, codes can be reused): 0.

CRSP screen is **not** the rich-put rule. It is the drawdown leg plus the old $3 / $300M floor. Income and 10% OTM need option quotes, which these names do not have. Month-end price vs the max of 12 month-end prices stands in for the daily 52-week high. Cap unit check: AAPL permno 14593 at 2024-11-29 = $3.59T (shrout × 1000).

Name-months 2020-12-01 → 2023-11-30 (12-month follow-up still inside the CRSP file). A row counts as a delist when `dlstdt` falls 1–366 days after that month-end.

| screen | name-months | permnos | any delist in 366d | 4xx+5xx | 5xx dropped | 4xx liquidation | 2xx merger |
|---|---:|---:|---:|---:|---:|---:|---:|
| ≥25% off 12m month-end high | 25,733 | 2,582 | 918 (3.57%) | 146 (0.57%) | 135 | 11 | 772 |
| not 25% off | 60,305 | 3,176 | 3,149 (5.22%) | 635 (1.05%) | 73 | 562 | 2,502 |

Unique eligible permnos, 2020-12-01 → 2024-11-30: ever ≥25% off = 2,651; never = 689. Fate = a delist row dated inside that window (a name is counted once).

| group | n | no delist row | 5xx | 4xx | 2xx | 3xx |
|---|---:|---:|---:|---:|---:|---:|
| ever ≥25% off | 2,651 | 2,294 | 106 | 2 | 249 | 0 |
| never 25% off | 689 | 487 | 32 | 71 | 98 | 1 |

Permnos that were ever ≥25% off while eligible and then 4xx or 5xx delisted by 2024-11: 108. Their last CRSP ticker is in `daily_history`: 1 (CORZ). In cached option roots: 1. S076 pricer was not run: it needs `iv30_put` on that name, and option-root coverage is 0.
Sample (ticker, permno, delist, code, in prices, in option roots): ODT 17154 2022-01-14 584 px=False opt=False; KLDO 18408 2022-04-14 570 px=False opt=False; ELMS 19830 2022-06-22 584 px=False opt=False; PSTH 19789 2022-07-25 450 px=False opt=False; EVFM 15075 2022-08-10 584 px=False opt=False; MUDS 20440 2022-09-12 450 px=False opt=False; REV 82859 2022-10-20 574 px=False opt=False; CLVS 13107 2022-12-20 584 px=False opt=False; PRTY 15327 2023-01-17 574 px=False opt=False; TCDA 17900 2023-01-23 584 px=False opt=False; ASAP 16173 2023-02-01 584 px=False opt=False; AVYA 17234 2023-02-14 574 px=False opt=False; SRNE 14262 2023-02-22 584 px=False opt=False; RUBY 17947 2023-03-06 584 px=False opt=False; SBNY 90090 2023-03-10 584 px=False opt=False ….

## 2. S088 — model price vs real quotes

Not a refit. Read from `analysis/s088_sr_zones.py` and `out/opt/S088.md`.

- Pricer: `from s076_structures_backtest import Pricer`. S076 sets the put mid to Black-Scholes at `iv30_put` × a skew ratio calibrated on cached LSEG quotes. Fill haircut `HAIRCUT` is 0.83–1.08 by IV bucket × distance, applied in `haircut_pnl`. That is a scalar on the model credit, not the bid/ask of the picked contract.
- Picks in the current script: `TOPN = 20` names per week (`pick()`), not top 10. Holdout 2023 →, 1-week, model + zones, P(kept) ≥ 90%: published row is n=3,982, model +81.0 bp/wk, haircut +64.0 bp/wk, kept 90.6%, week t 9.0. Plain 1σ: model +31.5, haircut +27.0.
- Haircut ÷ model on that row = 64.0/81.0 = 0.790. Same sign. This is the haircut column, not a LSEG replay, so it does not meet task 2's pass bar (real quote ≥ 0.8 × modelled).
- BOARD and the INDEX row still say top-10/wk **+77 bp/wk vs +35**. That row is not in the current `S088.md` table. This audit did not rebuild top-10 and did not match picks to `lseg_opt_daily`.
- No saved trade list of the P(kept) ≥ 90% backtest picks. `S088-ladder.json` is the ladder, not that book. Quote coverage of the book was therefore not counted.

## 3. Regime split of S109 (recomputed)

SPY 200-day: close vs mean of the last 200 SPY closes in `daily_history`, current day included. Breadth: share of other `daily_history` names (SPY/QQQ/IWM/DIA left out) whose close is under their own 200-day mean; days with <50 names dropped. VIX terciles are equal-weight on the rule's entry dates that have a VIXCLS print within 5 days (n dates 158, cuts 17.21 / 21.51). Rule puts missing a flag: SPY 0, breadth 0, VIX 0.
Same-weeks other puts = S109's comparator, restricted to weeks that have a rule put in that bucket. Halves use 2024-07-01. A half with <8 weeks is marked thin.

| bucket | rule | same-weeks other | rule names | halves |
|---|---|---|---:|---|
| SPY close > 200d MA | puts 284 · weeks 92 · +58.9 bp/wk · t +1.9 · kept 75% | puts 4843 · weeks 91 · +25.1 bp/wk · t +2.8 · kept 85% | 84 | pre-2024-07 +37.9 (t +0.6, weeks 36); from-2024-07 +72.5 (t +2.7, weeks 56) |
| SPY close ≤ 200d MA | puts 136 · weeks 43 · +114.8 bp/wk · t +3.8 · kept 88% | puts 1874 · weeks 42 · +24.5 bp/wk · t +1.1 · kept 86% | 63 | pre-2024-07 +143.7 (t +7.6, weeks 35); from-2024-07 -11.3 (t -0.1, weeks 8) |
| breadth < 40% of names below 200d | puts 156 · weeks 61 · +43.4 bp/wk · t +1.1 · kept 81% | puts 2498 · weeks 60 · +25.8 bp/wk · t +2.6 · kept 84% | 64 | pre-2024-07 +11.6 (t +0.1, weeks 25); from-2024-07 +65.4 (t +1.9, weeks 36) |
| breadth ≥ 40% of names below 200d | puts 264 · weeks 72 · +100.4 bp/wk · t +3.9 · kept 79% | puts 3914 · weeks 71 · +23.9 bp/wk · t +1.5 · kept 86% | 87 | pre-2024-07 +133.7 (t +5.1, weeks 43); from-2024-07 +51.0 (t +1.0, weeks 29) |
| VIX low (< 17.2) | puts 144 · weeks 50 · +49.4 bp/wk · t +1.0 · kept 69% | puts 3164 · weeks 50 · +11.7 bp/wk · t +1.0 · kept 84% | 53 | pre-2024-07 +38.8 (t +0.3, weeks 19); from-2024-07 +55.9 (t +1.2, weeks 31) |
| VIX mid (17.2–21.5) | puts 130 · weeks 44 · +47.1 bp/wk · t +1.2 · kept 80% | puts 2503 · weeks 43 · +16.8 bp/wk · t +0.8 · kept 86% | 55 | pre-2024-07 +60.2 (t +1.1, weeks 20); from-2024-07 +36.2 (t +0.6, weeks 24) |
| VIX high (≥ 21.5) | puts 146 · weeks 43 · +136.8 bp/wk · t +8.5 · kept 89% | puts 1912 · weeks 42 · +42.1 bp/wk · t +2.7 · kept 86% | 66 | pre-2024-07 +142.7 (t +6.8, weeks 31); from-2024-07 +121.8 (t +5.7, weeks 12) |
| 2021 | puts 14 · weeks 8 · +151.8 bp/wk · t +1.9 · kept 93% | puts 210 · weeks 8 · +33.7 bp/wk · t +1.9 · kept 88% | 9 | pre-2024-07 +151.8 (t +1.9, weeks 8); from-2024-07 thin |
| 2022 | puts 114 · weeks 31 · +88.6 bp/wk · t +2.9 · kept 83% | puts 1258 · weeks 30 · +14.1 bp/wk · t +0.7 · kept 83% | 49 | pre-2024-07 +88.6 (t +2.9, weeks 31); from-2024-07 thin |
| 2023 | puts 32 · weeks 17 · +172.7 bp/wk · t +4.1 · kept 88% | puts 510 · weeks 17 · +61.7 bp/wk · t +4.4 · kept 86% | 19 | pre-2024-07 +172.7 (t +4.1, weeks 17); from-2024-07 thin |
| 2024 | puts 43 · weeks 24 · +36.7 bp/wk · t +0.4 · kept 84% | puts 681 · weeks 23 · +39.2 bp/wk · t +2.1 · kept 85% | 20 | pre-2024-07 -71.4 (t -0.4, weeks 12); from-2024-07 +144.9 (t +8.7, weeks 12) |
| 2025 | puts 93 · weeks 26 · +22.8 bp/wk · t +0.4 · kept 78% | puts 1465 · weeks 26 · -4.8 bp/wk · t -0.2 · kept 86% | 50 | pre-2024-07 thin; from-2024-07 +22.8 (t +0.4, weeks 26) |
| 2026 | puts 124 · weeks 25 · +60.7 bp/wk · t +1.3 · kept 72% | puts 2249 · weeks 25 · +36.8 bp/wk · t +2.3 · kept 85% | 52 | pre-2024-07 thin; from-2024-07 +60.7 (t +1.3, weeks 25) |

## A371 packet

See `research/studies/out/a371-packet.md` (≤20 lines). Scripts: `analysis/a371_run.py`, `a371_survivorship.py`, `a371_s088_replay.py`.

**Still thin:** CRSP delisted roots without LSEG chains; S088 quote coverage 3%; full dead-table audit deferred (sample in packet).

