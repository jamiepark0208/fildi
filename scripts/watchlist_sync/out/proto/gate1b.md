# Gate 1b: simple fallbacks (2026-10-05)

52,419 reconstructed 30-day puts (Δ0.15 / 0.20 / 0.30), same data as gate 1. Success = put P&L > 0.

## B1 / B2. "Wins historically" lookup

**B1: by delta**

| cell | 2020–23 rate (n) | 2024–26 rate (n) | gap |
|---|---|---|---|
| Δ0.15 | 84.7% (9,481) | 89.0% (7,992) | +4.3 |
| Δ0.20 | 80.6% (9,481) | 85.3% (7,992) | +4.7 |
| Δ0.30 | 73.9% (9,481) | 78.1% (7,992) | +4.2 |

Largest gap 4.7 pts · test Brier 0.1333

**B2: by delta × PREMIUM tier**

| cell | 2020–23 rate (n) | 2024–26 rate (n) | gap |
|---|---|---|---|
| Δ0.15 · bottom | 83.6% (1,028) | 88.2% (1,009) | +4.6 |
| Δ0.15 · middle | 84.2% (7,329) | 89.2% (5,981) | +5.0 |
| Δ0.15 · top | 89.1% (1,124) | 88.2% (1,002) | -0.8 |
| Δ0.20 · bottom | 79.9% (1,028) | 84.1% (1,009) | +4.3 |
| Δ0.20 · middle | 80.1% (7,329) | 85.8% (5,981) | +5.7 |
| Δ0.20 · top | 84.4% (1,124) | 84.0% (1,002) | -0.4 |
| Δ0.30 · bottom | 73.7% (1,028) | 77.6% (1,009) | +3.9 |
| Δ0.30 · middle | 73.4% (7,329) | 78.5% (5,981) | +5.1 |
| Δ0.30 · top | 77.0% (1,124) | 76.4% (1,002) | -0.6 |

Largest gap 5.7 pts · test Brier 0.1336

- B1: **pass** (largest gap 4.7 pts, rule ≤ 5)
- B2: **keep B1** (Brier 0.1336 vs 0.1333; largest gap 5.7; tiers ordered bottom < middle < top in both periods: False)

## B3. Tail control on the Model List rule (0.20Δ puts; skipped month = 0)

| rule | period | months | trades | mean monthly | loss rate | tail rate | worst month |
|---|---|---|---|---|---|---|---|
| today (top 20 PREMIUM, SPY pause) | 2020–23 | 46 | 760 | +0.24% | 16.1% | 8.7% | -12.79% |
| today (top 20 PREMIUM, SPY pause) | 2024–26 | 33 | 660 | +0.86% | 15.6% | 8.2% | -3.55% |
| (a) ≤ 2 per peer group | 2020–23 | 46 | 760 | +0.19% | 16.8% | 8.6% | -15.40% |
| (a) ≤ 2 per peer group | 2024–26 | 33 | 660 | +1.28% | 13.2% | 7.0% | -3.51% |
| (b) no earnings in window | 2020–23 | 46 | 760 | +0.08% | 18.0% | 9.3% | -12.79% |
| (b) no earnings in window | 2024–26 | 33 | 660 | +1.11% | 13.5% | 5.6% | -1.51% |

- (a) ≤ 2 per peer group: **reject** (needs lower tail rate, better worst month, ≤ 0.10 pt return cost in both periods)
- (b) no earnings in window: **reject** (needs lower tail rate, better worst month, ≤ 0.10 pt return cost in both periods)

