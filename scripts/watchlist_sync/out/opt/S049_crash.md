# S049-crash — panic puts in broad vs sector-clustered crashes

| slice | n | mean % coll | ITM | worst 10 % |
|---|---|---|---|---|
| panic, idiosyncratic | 778 | +1.25% | 22% | -10.5% |
| panic, broad crash | 381 | +2.45% | 14% | -8.4% |
| panic + IV > 48.7, idiosyncratic | 413 | +2.18% | 21% | -12.2% |
| panic + IV > 48.7, broad crash | 246 | +3.45% | 13% | -7.5% |
| baseline, idiosyncratic | 1080 | +0.54% | 24% | -11.9% |
| baseline, broad crash | 199 | +2.11% | 17% | -7.9% |
| panic + IV > 48.7, alone in sector | 219 | +2.72% | 20% | -9.5% |
| panic + IV > 48.7, sector cluster | 440 | +2.62% | 18% | -11.5% |

p(event ≤ same-regime baseline), expiry-week bootstrap:
- panic, idiosyncratic: p = 0.053
- panic, broad: p = 0.229
- panic + IV > 48.7, idiosyncratic: p = 0.000
- panic + IV > 48.7, broad: p = 0.005

Worst decile by year, IV > 48.7, alone vs sector cluster:
- 2022: alone -13.7% (n 96) · cluster -15.3% (n 195)
- 2025: alone -7.7% (n 61) · cluster -5.3% (n 147)
- 2026: alone -3.5% (n 62) · cluster -11.5% (n 98)
