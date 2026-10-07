# Gate 1c: "wins historically" lookup (2026-10-05)

158,034 reconstructed trades (puts + covered calls × Δ (0.15, 0.2, 0.3) × (7, 14, 30)-day expiries), monthly entries 2020-03 →.

## Puts

| delta | expiry | 2020–23 | 2024–26 | gap | n test |
|---|---|---|---|---|---|
| 0.15 | 7d | 85.4% | 87.8% | +2.4 | 8,250 |
| 0.15 | 14d | 86.0% | 87.7% | +1.7 | 7,993 |
| 0.15 | 30d | 84.7% | 89.0% | +4.3 | 7,992 |
| 0.20 | 7d | 82.5% | 84.9% | +2.4 | 8,250 |
| 0.20 | 14d | 82.5% | 83.9% | +1.4 | 7,993 |
| 0.20 | 30d | 80.6% | 85.3% | +4.7 | 7,992 |
| 0.30 | 7d | 76.8% | 79.0% | +2.2 | 8,250 |
| 0.30 | 14d | 76.7% | 77.5% | +0.8 | 7,993 |
| 0.30 | 30d | 73.9% | 78.1% | +4.2 | 7,992 |

C1: largest gap 4.7 pts → **pass** (rule ≤ 5)

C2 per-stock blend: real between-stock spread ≈ ±1.7 pts (sd); prior strength k ≈ 596 trades (a stock with 596 trades counts half its own record). Test Brier cell 0.1356 vs per-stock 0.1357; halves 0.1451/0.1452 · 0.1259/0.1259 → **reject**

C3 average payout (σ units; × σ√T × strike = $ at risk): Δ0.15/7d 0.121→0.111 · Δ0.15/14d 0.122→0.078 · Δ0.15/30d 0.104→0.059 · Δ0.20/7d 0.154→0.140 · Δ0.20/14d 0.154→0.109 · Δ0.20/30d 0.139→0.087 · Δ0.30/7d 0.225→0.205 · Δ0.30/14d 0.225→0.178 · Δ0.30/30d 0.218→0.155

C3: **pass** (2024–26 within +30% of 2020–23 or lower in every cell)

## Calls

| delta | expiry | 2020–23 | 2024–26 | gap | n test |
|---|---|---|---|---|---|
| 0.15 | 7d | 85.1% | 86.9% | +1.8 | 8,250 |
| 0.15 | 14d | 86.4% | 84.9% | -1.4 | 7,993 |
| 0.15 | 30d | 88.1% | 86.6% | -1.5 | 7,992 |
| 0.20 | 7d | 81.1% | 82.8% | +1.7 | 8,250 |
| 0.20 | 14d | 82.1% | 80.7% | -1.4 | 7,993 |
| 0.20 | 30d | 84.6% | 82.6% | -1.9 | 7,992 |
| 0.30 | 7d | 74.0% | 75.0% | +1.0 | 8,250 |
| 0.30 | 14d | 74.1% | 72.9% | -1.3 | 7,993 |
| 0.30 | 30d | 77.1% | 74.8% | -2.2 | 7,992 |

C1: largest gap 2.2 pts → **pass** (rule ≤ 5)

C2 per-stock blend: real between-stock spread ≈ ±1.6 pts (sd); prior strength k ≈ 722 trades (a stock with 722 trades counts half its own record). Test Brier cell 0.1527 vs per-stock 0.1528; halves 0.1544/0.1545 · 0.1510/0.1510 → **reject**

C3 average payout (σ units; × σ√T × strike = $ at risk): Δ0.15/7d 0.108→0.095 · Δ0.15/14d 0.095→0.121 · Δ0.15/30d 0.087→0.113 · Δ0.20/7d 0.147→0.130 · Δ0.20/14d 0.133→0.161 · Δ0.20/30d 0.121→0.151 · Δ0.30/7d 0.234→0.213 · Δ0.30/14d 0.219→0.252 · Δ0.30/30d 0.200→0.237

C3: **pass** (2024–26 within +30% of 2020–23 or lower in every cell)

Shipped table (all history): `out/proto/winrates.json`.
