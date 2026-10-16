# Daily reflection — Fri 2026-10-16

Prices: DB closes + Schwab live for 556 names. Ideas: option_score_snapshots from the last 30 days, graded at today's close (or expiry). Method: `analysis/daily_reflection.py` header; study S014.

⚠ Data: LQDA 09/30 snapshot spot 53.22 vs close 30.26 (> 15% off → not graded)

## 1. Market

SPY +0.05% · QQQ -0.68% · IWM -0.21% · SMH -0.99%. Breadth: 335/565 up (59%); median +0.3%.

Biggest drops: SECZ -9.5%, MRNA -9.1%, QSI -8.4%, RXRX -7.8%, CRWV -7.3%, NBIS -6.2%, FSLY -6.0%, VNET -5.9%

Biggest gains: ALOY +9.1%, AA +8.6%, CLNE +5.6%, SEDG +4.4%, NTDOY +3.7%, CDE +3.7%, CAVA +3.6%, CLF +3.5%

## 2. Found but wrong

198 shown or top-decile ideas still being graded; 59 used ≥ 50% of the cushion (31 in the money).

| idea | from | score (pct) | shown | setup at entry | cushion used | move in σ | earnings |
|---|---|---|---|---|---|---|---|
| ASTS 60P 10/09 | 10/06 | 60 (93%) |  | no-dip | 454% | +2.2 |  |
| AAOI 96P 10/16 | 10/08 | 61 (93%) |  | no-dip | 307% | +1.7 |  |
| CLSK 10P 10/16 | 10/08 | 58 (91%) |  | dip | 301% | +1.4 |  |
| RUM 7P 10/16 | 10/06 | 69 (98%) |  | no-dip | 292% | +1.7 |  |
| RKLB 60P 10/16 | 10/13 | 78 (91%) |  | dip | 292% | +2.5 |  |
| HUT 84P 10/16 | 10/06 | 61 (94%) |  | no-dip | 287% | +1.4 |  |
| AAOI 122P 10/09 | 10/06 | 60 (93%) |  | no-dip | 285% | +1.5 |  |
| AAOI 97P 10/16 | 10/09 | 68 (91%) |  | dip | 272% | +2.2 |  |
| CLSK 11.5P 10/09 | 10/06 | 59 (90%) |  | dip | 260% | +1.5 |  |
| RIOT 18P 10/09 | 10/06 | 63 (96%) |  | dip | 224% | +1.3 |  |
| DNA 13P 10/16 | 10/05 | 62 (94%) |  | no-dip | 216% | +1.2 |  |
| FSLY 26P 10/16 | 10/09 | 70 (96%) |  | no-dip | 197% | +1.6 |  |
| ZS 217.5C 10/09 | 10/05 | 75 (94%) |  | no-rally | 188% | +1.6 |  |
| ZS 215C 10/09 | 10/04 | 76 (92%) |  | no-rally | 186% | +2.1 |  |
| ONTO 240P 10/16 | 10/13 | 80 (95%) |  | dip | 183% | +1.5 |  |

## 3. Real but missed

509 top-half ideas that weren't shown stayed safe (used < 20% of the cushion). Not a mistake by itself (most were never meant to be shown); it's a mistake when the shown ones did worse — see §5.

Best scores not shown: LQDA 30P 10/16 (88, used 9%), JBHT 210P 10/16 (87, moved away 6%), MRNA 245C 10/16 (87, moved away 3%), RXRX 4.5C 10/02 (86, moved away 3%), ARM 220P 10/16 (86, used 10%), LQDA 21P 10/16 (86, moved away 74%), DNA 14C 10/16 (85, moved away 35%), FSLY 31C 10/16 (84, moved away 117%), ARM 342.5C 10/09 (83, moved away 151%), HUM 330P 10/09 (83, moved away 63%)

Blocked plan contracts (L1 or verify): 149 stayed safe, 99 used ≥ 50% (the block was right). Expiry grades: `out/block_audit/report.md` (S013).

## 4. Your trades today

No filled orders loaded for this day.

## 5. Do the scores rank ideas? (relative check)

Per snapshot day and side: Spearman IC of option_score vs safety (−adverse move in σ). Positive = higher scores stayed safer. “IV fixed” partials out strike IV (METHODS #2). Shown vs not: mean cushion used.

| snapshot | side | n | IC raw | IC IV fixed | shown used | others used |
|---|---|---|---|---|---|---|
| 10/01 | call | 47 | +0.26 | +0.00 | — | 30% |
| 10/01 | put | 46 | -0.04 | +0.18 | — | 29% |
| 10/02 | call | 44 | +0.27 | -0.09 | — | 0% |
| 10/02 | put | 53 | -0.08 | +0.33 | — | 38% |
| 10/04 | call | 72 | +0.16 | -0.08 | — | 14% |
| 10/04 | put | 106 | -0.00 | +0.21 | 31% (1) | 9% |
| 10/05 | call | 70 | +0.33 | +0.00 | -395% (1) | 15% |
| 10/05 | put | 93 | -0.31 | +0.24 | -131% (1) | 55% |
| 10/06 | call | 104 | +0.33 | +0.07 | -120% (1) | -32% |
| 10/06 | put | 136 | -0.28 | +0.02 | -45% (2) | 78% |
| 10/08 | call | 63 | +0.47 | +0.31 | — | -25% |
| 10/08 | put | 57 | -0.35 | -0.22 | — | 115% |
| 10/09 | call | 79 | +0.30 | +0.23 | — | -62% |
| 10/09 | put | 70 | -0.22 | -0.06 | — | 99% |
| 10/11 | call | 120 | +0.39 | +0.29 | — | -51% |
| 10/11 | put | 129 | -0.06 | -0.02 | — | 72% |
| 10/13 | call | 113 | +0.37 | +0.29 | — | -33% |
| 10/13 | put | 149 | -0.35 | -0.20 | — | 40% |
| 10/14 | call | 107 | +0.26 | +0.22 | — | 21% |
| 10/14 | put | 142 | -0.33 | -0.22 | -110% (2) | -23% |
| 10/15 | call | 122 | +0.40 | +0.29 | — | 0% |
| 10/15 | put | 120 | -0.31 | -0.16 | -28% (2) | 3% |

Mean IC raw +0.06, IV fixed +0.07 over 22 day-sides (t +1.9). Overlapping days share moves, so t overstates; no claim before ≥ 8 distinct expiries (METHODS #9).

Expired so far: 1285 contracts. Top-half score: 78% won, median kept 100%, worst -2982% (765); bottom half: 80% won, median kept 100%, worst -1960% (520).

## 6. Setups forming (S011 rule, display only)

Put setups (dip / near 20-day low): FORM -22% 5d, 0% off low, SKHY -17% 5d, 0% off low, AMAT -17% 5d, 0% off low, TER -16% 5d, 0% off low, LRCX -15% 5d, 0% off low, SNDK -15% 5d, 0% off low, MRVL -14% 5d, 0% off low, DDOG -13% 5d, 4% off low, MU -12% 5d, 0% off low, MPWR -10% 5d, 0% off low, MDB -10% 5d, 4% off low, AMD -10% 5d, 0% off low

Call setups (rally ≥ 3% in 5 days): VIST +8%, MDT +8%, LLY +8%, COP +7%, CI +6%, VEEV +6%, SWKS +6%, BAX +6%, PINS +6%, ABNB +6%, CRM +5%, UNH +5%

## 7. Mistake patterns (cumulative)

97 logged rows over 5 day(s) (`out/reflection/log.csv`).

| kind | rows | days | top names | by setup | by side |
|---|---|---|---|---|---|
| found_wrong | 75 | 5 | AAOI×12, ZS×7, CLSK×7, ASTS×7 | dip 31, no-dip 30, no-rally 12 | put 61, call 14 |
| trader_no-dip | 11 | 2 | ONDS×7, POET×2, MP×1, RKLB×1 | no-dip 11 | put 11 |
| data_bad_spot | 5 | 5 | LQDA×5 | ? 5 |  5 |
| trader_low_score | 4 | 3 | NVDA×3, OPEN×1 | rally 2, no-rally 1, dip 1 | call 3, put 1 |
| trader_no-rally | 2 | 1 | NVDA×1, MP×1 | no-rally 2 | call 2 |

Found-but-wrong traits: 42/75 entered without the S011 setup; 0/75 had an earnings flag.

Read a pattern only once a kind repeats on ≥ 5 different days; then pre-register a study (research/studies/README.md).
