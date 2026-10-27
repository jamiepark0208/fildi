# Step 3 prototype (2026-10-27)

Recomputed blend matches stored fv-1.1.0 on 100% of 791 names (rest: stored value uses inputs the vote list doesn't carry). Warranted P/E v2 out-of-fold R² on log P/E 0.43.

Pricing error |log(FV/price)| unless stated; lower is better. Street ρ is circular for V2–V4 (street is in the blend).

| metric | V0 fv-1.1.0 (stored) | V1 warranted P/E v2 | V2 street anchor 1/3 | V3 = V1 + V2 | V4 = V3 + replace peer P/E on 2× mismatch | V5 = V4 + ≥ 2 internal votes | V6 = V5 + street 1/2 on misfit |
|---|---|---|---|---|---|---|---|
| n | 791 | 791 | 791 | 791 | 791 | 758 | 758 |
| median |log| | 0.23 | 0.23 | 0.20 | 0.19 | 0.19 | 0.18 | 0.16 |
| > 50 % off | 27% | 25% | 22% | 19% | 19% | 16% | 12% |
| > 2× off | 9% | 8% | 6% | 5% | 5% | 3% | 2% |
| bias (median log) | +0.03 | +0.03 | +0.04 | +0.04 | +0.04 | +0.04 | +0.05 |
| rank ρ vs street | +0.17 | +0.19 | +0.26 | +0.28 | +0.29 | +0.27 | +0.35 |
| own P/E > 2× peer | 0.68 | 0.64 | 0.47 | 0.45 | 0.36 | 0.36 | 0.23 |
| own P/E < 0.5× peer | 0.79 | 0.73 | 0.69 | 0.64 | 0.62 | 0.62 | 0.52 |
| PVGO > 60 % | 0.32 | 0.30 | 0.23 | 0.22 | 0.22 | 0.22 | 0.15 |
| fintech | 0.73 | 0.67 | 0.62 | 0.59 | 0.51 | 0.27 | 0.27 |
| Semis design | 0.44 | 0.42 | 0.27 | 0.26 | 0.26 | 0.26 | 0.23 |
| Med devices | 0.36 | 0.27 | 0.32 | 0.24 | 0.24 | 0.23 | 0.22 |
| Software | 0.33 | 0.33 | 0.32 | 0.32 | 0.32 | 0.28 | 0.25 |
| Autos & EVs | 0.72 | 0.59 | 0.74 | 0.57 | 0.57 | 0.55 | 0.55 |
| financials+REIT+utility | 0.16 | 0.16 | 0.14 | 0.14 | 0.14 | 0.14 | 0.14 |

## Worst 30 under fv-1.1.0: before → V6

| ticker | group | own P/E | peer P/E | warranted v2 | fv-1.1.0 | V6 | street |
|---|---|---|---|---|---|---|---|
| GKOS | Medical Devices & Equipment | 350.8 | nan | - | -95% | - | +8% |
| TSLA | Autos & EVs | 159.1 | 7.0 | - | -90% | -69% | +1% |
| GH | Medical Devices & Equipment | nan | nan | - | -85% | - | +13% |
| PLTR | Enterprise Software & Cloud | 124.3 | nan | 52.9 | -84% | -63% | +5% |
| DDOG | Enterprise Software & Cloud | 109.7 | nan | 44.4 | -83% | -58% | +4% |
| MRNA | Large Biotech | nan | nan | - | -82% | - | -28% |
| NTRA | Medical Devices & Equipment | nan | nan | - | -82% | - | -3% |
| PANW | Enterprise Software & Cloud | 93.4 | nan | 32.5 | -81% | -57% | +2% |
| MU | Semiconductors — Design | 5.2 | 32.9 | 18.7 | +311% | +155% | +70% |
| YELP | Consumer Internet & Digital Media | 10.8 | 44.6 | 14.3 | +290% | +84% | +27% |
| ARM | Semiconductors — Design | 100.3 | 31.7 | 58.6 | -74% | -41% | +28% |
| SHOP | Enterprise Software & Cloud | 88.8 | nan | 51.3 | -71% | -50% | +5% |
| MDB | Enterprise Software & Cloud | 59.5 | nan | 38.8 | -71% | -44% | +15% |
| CRCL | Digital Finance & Payments | 73.3 | 15.5 | 26.2 | -71% | -33% | +31% |
| RGEN | Medical Devices & Equipment | 84.6 | 21.3 | 27.5 | -70% | -41% | +16% |
| MDGL | Large Biotech | 45.6 | nan | 24.9 | -70% | - | +56% |
| SNDK | Semiconductors — Design | 5.8 | 32.9 | 27.5 | +232% | +153% | +68% |
| CCJ | Base Metals & Mining | 55.1 | 14.7 | 24.7 | -70% | -31% | +49% |
| CHYM | Digital Finance & Payments | 62.1 | 15.5 | 46.8 | -70% | -8% | +40% |
| CAVA | Restaurants & Food Service | 94.9 | 23.8 | 21.2 | -70% | -34% | +63% |
| ILMN | Medical Devices & Equipment | 52.6 | 21.3 | 21.2 | -67% | -48% | -12% |
| SMCI | IT Hardware & Networking | 7.1 | 18.9 | 22.0 | +206% | +104% | +34% |
| OMC | Professional Services | 8.0 | 20.4 | 11.9 | +197% | +80% | +28% |
| PEN | Medical Devices & Equipment | 69.3 | 21.3 | 18.9 | -66% | -42% | +13% |
| ZS | Enterprise Software & Cloud | 53.3 | nan | 39.0 | -65% | -48% | -10% |
| CHTR | Telecommunications | 3.4 | 8.6 | 15.7 | +181% | +188% | +102% |
| GM | Autos & EVs | 5.7 | 10.3 | 19.4 | +176% | +127% | +29% |
| TWLO | Enterprise Software & Cloud | 42.8 | nan | 36.2 | -62% | -37% | +8% |
| FROG | Enterprise Software & Cloud | 102.6 | nan | 51.1 | -62% | - | +12% |
| ALAB | Semiconductors — Design | 70.5 | 31.7 | 48.6 | -61% | -27% | +40% |
