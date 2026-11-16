# A407 step 2 — sector slot cap on an 8-slot weekly put book

29,698 engine picks. Seeds 50, slots 8. bp = per collateral-week. Method: script docstring.

## holdout 2023 → — 187 weeks, 21,131 picks; avg largest-sector share of the pool 22 %

| cap / sector | book bp/wk | Δ vs none | t | worst-5 % wk | Δ | worst-1 % wk | verdict |
|---|---|---|---|---|---|---|---|
| none | +28.7 | | | -38 | | -150 | |
| 3 | +28.6 | -0.1 | -0.9 | -38 | -1 | -151 | SAME |
| 2 | +28.1 | -0.6 | -2.2 | -35 | +2 | -150 | SAME |
| 1 | +26.5 | -2.2 | -3.4 | -37 | +1 | -132 | WORSE |

## fit period < 2023 — 142 weeks, 8,567 picks; avg largest-sector share of the pool 22 %

| cap / sector | book bp/wk | Δ vs none | t | worst-5 % wk | Δ | worst-1 % wk | verdict |
|---|---|---|---|---|---|---|---|
| none | +31.4 | | | -80 | | -266 | |
| 3 | +31.0 | -0.3 | -2.2 | -80 | +0 | -262 | SAME |
| 2 | +30.6 | -0.8 | -1.9 | -79 | +1 | -256 | SAME |
| 1 | +29.6 | -1.8 | -1.5 | -89 | -9 | -256 | SAME |

