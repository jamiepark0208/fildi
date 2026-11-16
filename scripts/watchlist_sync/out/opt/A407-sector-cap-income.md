# A407 step 2 — sector slot cap on an 8-slot weekly put book (slot fill: income)

29,698 engine picks. Seeds 1, slots 8. bp = per collateral-week. Method: script docstring.

## holdout 2023 → — 187 weeks, 21,131 picks; avg largest-sector share of the pool 22 %

| cap / sector | book bp/wk | Δ vs none | t | worst-5 % wk | Δ | worst-1 % wk | verdict |
|---|---|---|---|---|---|---|---|
| none | +81.2 | | | -113 | | -396 | |
| 3 | +78.1 | -3.0 | -0.6 | -118 | -5 | -557 | SAME |
| 2 | +70.1 | -11.0 | -1.4 | -229 | -116 | -586 | SAME |
| 1 | +60.5 | -20.7 | -2.1 | -145 | -32 | -409 | WORSE |

## fit period < 2023 — 142 weeks, 8,567 picks; avg largest-sector share of the pool 22 %

| cap / sector | book bp/wk | Δ vs none | t | worst-5 % wk | Δ | worst-1 % wk | verdict |
|---|---|---|---|---|---|---|---|
| none | +84.2 | | | -102 | | -270 | |
| 3 | +82.3 | -1.9 | -0.9 | -162 | -60 | -280 | SAME |
| 2 | +77.8 | -6.4 | -1.6 | -134 | -32 | -236 | SAME |
| 1 | +68.0 | -16.2 | -3.2 | -100 | +1 | -205 | WORSE |

