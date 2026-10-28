# S123 / A295 smoke — earnings breadth B(t)

Tickers with IBES EPS FY1 since 2024-01-01: **20/20**
Breadth months computed: **29**
GPRD_MA30 rows since 2024-01-01: **1030** (last 2026-10-26 = 175.44)

## Recent B(t)

| ym | B | ΔB 3m | n | state |
|---|---:|---:|---:|---|
| 2025-03 | +35.0 | -10.0 | 20 | late |
| 2025-04 | +25.0 | -15.0 | 20 | late |
| 2025-05 | -10.0 | -50.0 | 20 | near_neg |
| 2025-06 | -15.0 | -50.0 | 20 | downcycle |
| 2025-07 | +0.0 | -25.0 | 20 | near_neg |
| 2025-08 | +35.0 | +45.0 | 20 | upcycle |
| 2025-09 | +45.0 | +60.0 | 20 | upcycle |
| 2025-10 | +45.0 | +45.0 | 20 | upcycle |
| 2025-11 | +45.0 | +10.0 | 20 | upcycle |
| 2025-12 | +50.0 | +5.0 | 20 | upcycle |
| 2026-01 | +50.0 | +5.0 | 20 | upcycle |
| 2026-02 | +80.0 | +35.0 | 20 | upcycle |
| 2026-03 | +85.0 | +35.0 | 20 | upcycle |
| 2026-04 | +80.0 | +30.0 | 20 | upcycle |
| 2026-05 | +60.0 | -20.0 | 20 | late |
| 2026-06 | +65.0 | -20.0 | 20 | late |
| 2026-07 | +85.0 | +5.0 | 20 | upcycle |
| 2026-08 | +60.0 | +0.0 | 20 | upcycle |

## Hand-check (3 months × NVDA/AAPL/JPM)

- NVDA 2025-06: FY1 4.520→4.310 (-4.6%) vs 2025-03; raw near month-end: []
- AAPL 2025-06: FY1 7.320→7.170 (-2.0%) vs 2025-03; raw near month-end: []
- JPM 2025-06: FY1 18.330→18.330 (+0.0%) vs 2025-03; raw near month-end: []
- NVDA 2025-09: FY1 4.310→4.490 (+4.2%) vs 2025-06; raw near month-end: []
- AAPL 2025-09: FY1 7.170→7.370 (+2.8%) vs 2025-06; raw near month-end: []
- JPM 2025-09: FY1 18.330→19.570 (+6.8%) vs 2025-06; raw near month-end: []
- NVDA 2025-12: FY1 4.490→4.670 (+4.0%) vs 2025-09; raw near month-end: []
- AAPL 2025-12: FY1 7.370→8.250 (+11.9%) vs 2025-09; raw near month-end: []
- JPM 2025-12: FY1 19.570→20.260 (+3.5%) vs 2025-09; raw near month-end: []

## Smoke verdict

- PASS smoke if: ≥15/20 tickers have EPS, ≥12 months of B, hand-check Δ matches raw IBES within rounding,
  and gprd_ma30 has rows.
- Result: tickers=20/20 · months=29 · geo_rows=1030 · **continue to full S123**

Refs: A295 · next: full script on 949-name universe + S076/S101 join (fit ≤2022, grade 2023→).
