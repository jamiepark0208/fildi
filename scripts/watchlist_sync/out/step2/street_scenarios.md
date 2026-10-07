# Step 2: STREET scenario analysis (2026-10-05)

Inputs: fit_score_history run 2026-10-05 11:26 (265 names, 250 non-ETF), model fit-1.3. Same point-in-time inputs in every scenario; only STREET's role changes. Baseline code pinned in `out/baselines/step2_20261005/manifest.json`.

## 1. Verdict counts

| scenario | green | yellow | red | none | changed vs S0 |
|---|---|---|---|---|---|
| S0 | 31 | 14 | 47 | 158 | 0 |
| S1 | 44 | 15 | 64 | 127 | 43 |
| S1-flagsonly | 44 | 15 | 17 | 174 | 46 |
| S2k5 | 47 | 12 | 67 | 124 | 37 |
| S2k10 | 48 | 14 | 66 | 122 | 41 |
| S2k15 | 54 | 16 | 69 | 111 | 52 |
| S2k10-bothrule | 48 | 14 | 47 | 141 | 22 |

### Transitions S0 → S1

| from → to | n | tickers |
|---|---|---|
| none → red | 22 | AAOI AFRM ALOY BNGO CABA COIN COMP CRSP CRWV HYLN LUMN MRNA MSTR NBIS O QSI RDW REBN RUM SOFI SPCE W |
| none → green | 11 | AAPL ADBE AU AVGO COP DIS GEV HUBS LYFT SKHY V |
| red → none | 5 | APP COTY LQDA NKE PCG |
| none → yellow | 3 | IOND TTD ZG |
| yellow → green | 2 | MO PFLT |

### Transitions S0 → S1-flagsonly

| from → to | n | tickers |
|---|---|---|
| red → none | 30 | AAL APP ASTS BA CELH CLNE CMPS COTY DNA HIMS HUT IONQ IREN LDI LQDA LUNR MGM MP NCLH NKE NTLA OKLO OPEN PCG QBTS RIOT RKT SG WBD WYNN |
| none → green | 11 | AAPL ADBE AU AVGO COP DIS GEV HUBS LYFT SKHY V |
| none → yellow | 3 | IOND TTD ZG |
| yellow → green | 2 | MO PFLT |

### Transitions S0 → S2k10

| from → to | n | tickers |
|---|---|---|
| none → red | 19 | AAOI ALOY BNGO CABA COIN COMP CRSP CRWV LUMN MRNA MSTR NBIS O QSI RDW REBN RUM SOFI SPCE |
| none → green | 14 | AAPL ADBE AVGO BOX COP DIS DUOL GEV HUBS KLAC MPC SKHY TGT V |
| none → yellow | 4 | HOOD KOPN SMCI SNAP |
| yellow → green | 3 | MO TOST UBER |
| yellow → none | 1 | BX |

### Transitions S0 → S2k10-bothrule

| from → to | n | tickers |
|---|---|---|
| none → green | 14 | AAPL ADBE AVGO BOX COP DIS DUOL GEV HUBS KLAC MPC SKHY TGT V |
| none → yellow | 4 | HOOD KOPN SMCI SNAP |
| yellow → green | 3 | MO TOST UBER |
| yellow → none | 1 | BX |

## 2. Rank stability of the ownership score

| compare | Spearman ρ | n | top-30 overlap |
|---|---|---|---|
| OWN vs OWN±5·STREET | 0.994 | 250 | 27/30 |
| OWN vs OWN±10·STREET | 0.982 | 250 | 26/30 |
| OWN vs OWN±15·STREET | 0.965 | 250 | 24/30 |

## 3. Double-counting check: STREET vs the fund score (which already has PT upside, EPS surprise, IBES revisions/SUE)

| pair | Spearman ρ | n |
|---|---|---|
| STREET vs fund_growth | 0.156 | 174 |
| STREET vs fund_total | 0.185 | 215 |
| ARM (revisions) vs fund_growth | 0.138 | 174 |
| ARM (revisions) vs fund_total | 0.177 | 215 |
| pred. surprise vs fund_growth | 0.087 | 172 |
| pred. surprise vs fund_total | 0.123 | 212 |
| EPS drift 30d vs fund_growth | 0.019 | 173 |
| EPS drift 30d vs fund_total | 0.001 | 214 |
| STREET vs OWN | 0.479 | 215 |

## 4. Current put ideas under each scenario (sell-puts cross-check)

| ticker | S0 | S1 | S1-flagsonly | S2k5 | S2k10 | S2k15 | S2k10-bothrule |
|---|---|---|---|---|---|---|---|
| BEAM | ✋ – (41) | ✋ – (41) | ✋ – (41) | ✋ – (41) | ✋ – (41) | ✋ – (41) | ✋ – (41) |
| CAVA | ✅ – (50) | ✅ – (50) | ✅ – (50) | ✅ – (49) | ✅ – (48) | ✅ – (48) | ✅ – (48) |
| DVN | ✅ – (57) | ✅ – (57) | ✅ – (57) | ✅ – (59) | ✅ – (61) | ✅ green (63) | ✅ – (61) |
| ETSY | ✅ yellow (50) | ✅ yellow (50) | ✅ yellow (50) | ✅ yellow (52) | ✅ yellow (54) | ✅ yellow (57) | ✅ yellow (54) |
| HPQ | ✅ – (53) | ✅ – (53) | ✅ – (53) | ✅ – (53) | ✅ – (53) | ✅ – (53) | ✅ – (53) |
| LUMN | ✋ – (30) | ✋ red (30) | ✋ – (30) | ✋ red (29) | ✋ red (28) | ✋ red (26) | ✋ – (28) |
| MNDY | ✅ – (57) | ✅ – (57) | ✅ – (57) | ✅ – (57) | ✅ – (57) | ✅ – (57) | ✅ – (57) |
| NFLX | ✅ – (59) | ✅ – (59) | ✅ – (59) | ✅ – (58) | ✅ – (56) | ✅ – (55) | ✅ – (56) |
| OXY | ✅ – (55) | ✅ – (55) | ✅ – (55) | ✅ – (60) | ✅ – (65) | ✅ – (69) | ✅ – (65) |
| POET | ✋ – (45) | ✋ – (45) | ✋ – (45) | ✋ – (44) | ✋ – (44) | ✋ – (43) | ✋ – (44) |
| PYPL | ✋ – (43) | ✋ – (43) | ✋ – (43) | ✋ – (42) | ✋ – (42) | ✋ – (42) | ✋ – (42) |
| RIG | ✅ – (48) | ✅ – (48) | ✅ – (48) | ✅ – (48) | ✅ – (48) | ✅ – (48) | ✅ – (48) |
| SOFI | ✋ – (28) | ✋ red (28) | ✋ – (28) | ✋ red (27) | ✋ red (26) | ✋ red (26) | ✋ – (26) |
| TPG | ✅ – (50) | ✅ – (50) | ✅ – (50) | ✅ – (50) | ✅ – (50) | ✅ – (50) | ✅ – (50) |
| TTD | ✋ – (49) | ✅ yellow (49) | ✅ yellow (49) | ✋ – (47) | ✋ – (44) | ✋ – (41) | ✋ – (44) |

## 5. Biggest movers with STREET as ±10 reward/penalty

- Up: OXY +9.5 (STREET 98), MPC +9.2 (STREET 96), CVX +8.9 (STREET 95), BP +8.9 (STREET 94), XOM +8.4 (STREET 92), KOPN +7.8 (STREET 89), MU +7.3 (STREET 86), ASML +6.3 (STREET 82)
- Down: DAL -9.1 (STREET 4), MP -8.8 (STREET 6), NKE -8.5 (STREET 7), AAL -8.3 (STREET 9), RIOT -8.2 (STREET 9), OPEN -7.9 (STREET 10), CLSK -7.7 (STREET 11), HUT -7.5 (STREET 12)

## 6. Early predictive evidence (StarMine history → next 21 trading days, monthly cross-section)

| signal | months | mean IC | t-stat | months IC>0 | avg names |
|---|---|---|---|---|---|
| pred_surprise_pct_fq1 | 17 | +0.020 | +0.73 | 59% | 88 |
| combined_alpha_rank | 17 | +0.052 | +1.13 | 59% | 101 |

Caveats: ~18 months of prices and ~105 names, so |IC| < ~0.05 is noise. ARM and EPS drift have no history here yet (only combined alpha + predicted surprise), and there's no fund-score history, so OWN can't be tested the same way. Step 3 (LSEG history pull, WRDS CRSP/IBES) is what makes this conclusive.

## 7. Conclusions (Claude, for user approval)
1. **Clean STREET effect = `S2k10-bothrule`** (red rule held fixed): 22 of 250 verdicts change, **no new reds**. 14 → green are high-OWN names that the S0 STREET ≥ 55 gate blocked on lukewarm analysts (AAPL, ADBE, AVGO, V, DIS, KLAC, GEV…). 4 → yellow (HOOD, KOPN, SMCI, SNAP), 3 yellow → green, BX loses yellow (STREET 33).
2. **Ranks barely move:** OWN vs OWN ± 10·STREET has Spearman 0.982, and the top 30 overlap 26/30. The reward/penalty layer differentiates at the margins, as designed, without overturning the base.
3. **Little double-counting:** STREET vs fund_growth 0.156, vs fund_total 0.185. STREET vs OWN is 0.479, mostly via CAM inside OWN (StarMine combined alpha includes revisions). So STREET is mostly new information versus the fund score, but partly overlaps CAM.
4. **Excluding STREET (S1) loses the TTD call:** TTD becomes yellow and its put passes. S2 keeps TTD blocked because the ARM ≤ 15 flag stays as a penalty. So keep the STREET flags.
5. **Risk seen:** a reward can lift a weak-balance-sheet name over the line (SMCI: credit 19, OWN 43 → 48.6 → yellow). Rule proposal: rewards can't carry a name across a hard floor (credit < 20, or base OWN < 40 for yellow/green).
6. **Predictive evidence is not conclusive yet:** combined alpha IC +0.052 (t 1.13), predicted surprise IC +0.020 (t 0.73), 17 months. Positive sign, not significant. Treat k = 10 as provisional until Step 4.
7. **Separate decision (not STREET): the red rule.** "OWN < 35 alone is red" adds 19 reds (SOFI, COIN, MSTR, NBIS, CRWV, RUM, AAOI…); "flags only" removes 30 (MP, OPEN, NKE, HIMS…). S0's "OWN *and* STREET < 35" sits between them.

**Proposed fit-1.4 (needs user approval):** STREET moves from a gate to a ±10 reward/penalty on OWN; STREET flags remain penalties; hard floors stop rewards lifting credit < 20 / base OWN < 40 names into yellow/green; red rule unchanged. k is revisited after Step 4.
