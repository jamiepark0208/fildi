# Daily reflection — Fri 2026-10-09

Prices: DB closes. Ideas: option_score_snapshots from the last 30 days, graded at today's close (or expiry). Method: `analysis/daily_reflection.py` header; study S014.

⚠ Data: LQDA 09/30 snapshot spot 53.22 vs close 30.26 (> 15% off → not graded)

## 1. Market

SPY +0.60% · QQQ +0.49% · IWM +0.49% · SMH -0.65%. Breadth: 346/565 up (61%); median +0.4%.

Biggest drops: TMUS -13.3%, T -10.8%, ASTS -10.5%, VZ -10.1%, LDI -8.9%, FRSX -7.6%, HPQ -6.9%, GOSS -5.8%

Biggest gains: QSI +25.4%, FSLY +15.9%, CCI +15.6%, DNA +14.6%, MRNA +14.2%, HUM +11.6%, RXRX +10.4%, HIMS +10.2%

## 2. Found but wrong

95 shown or top-decile ideas still being graded; 33 used ≥ 50% of the cushion (19 in the money).

| idea | from | score (pct) | shown | setup at entry | cushion used | move in σ | earnings |
|---|---|---|---|---|---|---|---|
| ASTS 60P 10/09 | 10/06 | 60 (93%) |  | no-dip | 454% | +2.2 |  |
| AAOI 122P 10/09 | 10/06 | 60 (93%) |  | no-dip | 285% | +1.5 |  |
| CLSK 11.5P 10/09 | 10/06 | 59 (90%) |  | dip | 260% | +1.5 |  |
| RIOT 18P 10/09 | 10/06 | 63 (96%) |  | dip | 224% | +1.3 |  |
| ZS 217.5C 10/09 | 10/05 | 75 (94%) |  | no-rally | 188% | +1.6 |  |
| ZS 215C 10/09 | 10/04 | 76 (92%) |  | no-rally | 186% | +2.1 |  |
| ASTS 54P 10/09 | 10/04 | 72 (92%) |  | dip | 178% | +1.3 |  |
| MRNA 207.5C 10/09 | 10/06 | 79 (100%) |  | no-rally | 171% | +1.8 |  |
| MRNA 210C 10/09 | 10/02 | 79 (100%) |  | no-rally | 162% | +2.0 |  |
| NU 15C 10/09 | 10/04 | 83 (97%) |  | no-rally | 159% | +1.9 |  |
| ASTS 53P 10/09 | 10/02 | 66 (94%) |  | dip | 155% | +1.3 |  |
| QBTS 16P 10/02 | 10/01 | 77 (96%) |  | dip | 146% | +1.4 |  |
| CHTR 105P 10/09 | 10/04 | 71 (91%) |  | dip | 140% | +0.7 |  |
| AAOI 112P 10/09 | 10/05 | 64 (96%) |  | no-dip | 127% | +0.8 |  |
| SEDG 32.5P 10/09 | 10/06 | 61 (95%) |  | no-dip | 119% | +0.6 |  |

## 3. Real but missed

223 top-half ideas that weren't shown stayed safe (used < 20% of the cushion). Not a mistake by itself (most were never meant to be shown); it's a mistake when the shown ones did worse — see §5.

Best scores not shown: RXRX 4.5C 10/02 (86, moved away 3%), ARM 342.5C 10/09 (83, moved away 151%), HUM 330P 10/09 (83, moved away 63%), LCID 4.5C 10/02 (82, moved away 17%), TEM 85C 10/09 (82, moved away 82%), MRNA 205C 10/02 (81, moved away 14%), INTC 127C 10/02 (81, moved away 20%), LQDA 20P 10/16 (81, moved away 19%), IONQ 47.5C 10/02 (80, moved away 9%), RIG 5P 10/02 (79, used 15%)

Blocked plan contracts (L1 or verify): 66 stayed safe, 38 used ≥ 50% (the block was right). Expiry grades: `out/block_audit/report.md` (S013).

## 4. Your trades today

| time | acct | trade | fill | our score (pct) | Model List | fit | setup | cushion now |
|---|---|---|---|---|---|---|---|---|
| 09:11 | 5425 | close 1 NVDA 247.5C 10/16 | 0.17 | | | | | P&L +70$ (sold 0.87) |
| 10:04 | 7796 | sell 1000 REBN | 2.065 | | | red | | |
| 10:05 | 7796 | sell 1000 REBN | 2.05 | | | red | | |
| 10:08 | 5425 | close 1 HOOD 109P 10/09 | 0.29 | | | | | P&L +42$ (sold 0.71) |
| 10:33 | 5425 | sell 1 MP 44P 10/16 | 0.46 | 50 (64%) |  | red | dip | +4.6% OTM |
| 10:34 | 5425 | sell 1 RKLB 63P 10/16 | 0.57 | 54 (77%) |  |  | no-dip | +7.6% OTM |
| 10:36 | 5425 | buy 10 GOSS | 9.695 | | | red | | |
| 10:53 | 7796 | sell 1 USAR 12P 10/16 | 0.14 | 47 (51%) |  |  | dip | +4.5% OTM |
| 11:43 | 5425 | sell 1 NVDA 245C 10/16 | 0.22 | 46 (22%) |  | green | no-rally | +6.9% OTM |
| 12:42 | 5425 | close 2 RGTI 14P 10/09 | 0.03 | | | | | P&L +16$ (sold 0.11) |
| 12:43 | 5425 | close 1 USAR 12.5P 10/09 | 0.02 | | | | | P&L +6$ (sold 0.08) |
| 12:44 | 5425 | sell 3 OPEN 2P 10/16 | 0.01 | 43 (35%) |  | red | dip | +9.9% OTM |
| 12:46 | 5425 | sell 1 MP 51C 10/16 | 0.17 | 54 (54%) |  | red | no-rally | +10.5% OTM |

6 opens, $159 premium; concentration: MP ×2, RKLB ×1, USAR ×1, NVDA ×1.

## 5. Do the scores rank ideas? (relative check)

Per snapshot day and side: Spearman IC of option_score vs safety (−adverse move in σ). Positive = higher scores stayed safer. “IV fixed” partials out strike IV (METHODS #2). Shown vs not: mean cushion used.

| snapshot | side | n | IC raw | IC IV fixed | shown used | others used |
|---|---|---|---|---|---|---|
| 10/01 | call | 47 | +0.21 | -0.04 | — | 32% |
| 10/01 | put | 46 | -0.20 | -0.05 | — | -16% |
| 10/02 | call | 44 | +0.23 | -0.09 | — | 12% |
| 10/02 | put | 53 | -0.18 | +0.13 | — | -6% |
| 10/04 | call | 72 | +0.08 | -0.11 | — | 20% |
| 10/04 | put | 106 | -0.05 | +0.08 | 31% (1) | -17% |
| 10/05 | call | 70 | +0.15 | -0.10 | -145% (1) | 7% |
| 10/05 | put | 93 | -0.30 | +0.14 | 25% (1) | 23% |
| 10/06 | call | 104 | +0.17 | -0.03 | -120% (1) | -12% |
| 10/06 | put | 136 | -0.28 | -0.11 | -45% (2) | 24% |
| 10/08 | call | 63 | -0.17 | -0.23 | — | 18% |
| 10/08 | put | 57 | -0.15 | -0.11 | — | -13% |

Mean IC raw -0.04, IV fixed -0.04 over 12 day-sides (t -1.4). Overlapping days share moves, so t overstates; no claim before ≥ 8 distinct expiries (METHODS #9).

Expired so far: 361 contracts. Top-half score: 81% won, median kept 100%, worst -1984% (257); bottom half: 85% won, median kept 100%, worst -1960% (104).

## 6. Setups forming (S011 rule, display only)

Put setups (dip / near 20-day low): SKHY -13% 5d, 0% off low, TER -10% 5d, 22% off low, TMUS -9% 5d, 0% off low, LRCX -8% 5d, 18% off low, SNDK -8% 5d, 4% off low, FORM -6% 5d, 37% off low, AMAT -6% 5d, 22% off low, KLAC -5% 5d, 17% off low, CAT -5% 5d, 2% off low, ASML -5% 5d, 13% off low, MU -4% 5d, 11% off low, BB -4% 5d, 17% off low

Call setups (rally ≥ 3% in 5 days): PBR +17%, MNDY +13%, SHOP +13%, PINS +11%, PLTR +11%, TEAM +10%, VEEV +8%, RDDT +8%, MDB +8%, MPC +8%, FTNT +8%, V +7%

## 7. Mistake patterns (cumulative)

65 logged rows over 3 day(s) (`out/reflection/log.csv`).

| kind | rows | days | top names | by setup | by side |
|---|---|---|---|---|---|
| found_wrong | 45 | 3 | AAOI×5, ZS×5, ASTS×5, QBTS×3 | dip 17, no-dip 16, no-rally 10 | put 33, call 12 |
| trader_no-dip | 11 | 2 | ONDS×7, POET×2, MP×1, RKLB×1 | no-dip 11 | put 11 |
| trader_low_score | 4 | 3 | NVDA×3, OPEN×1 | rally 2, no-rally 1, dip 1 | call 3, put 1 |
| data_bad_spot | 3 | 3 | LQDA×3 | ? 3 |  3 |
| trader_no-rally | 2 | 1 | NVDA×1, MP×1 | no-rally 2 | call 2 |

Found-but-wrong traits: 26/45 entered without the S011 setup; 0/45 had an earnings flag.

Read a pattern only once a kind repeats on ≥ 5 different days; then pre-register a study (research/studies/README.md).
