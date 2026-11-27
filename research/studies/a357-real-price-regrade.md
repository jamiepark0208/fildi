# A357 — real-price re-grade (LSE traded entry) · **INTERIM**

LSE daily OCCs: 2017 · sample plan: 6202 events / 50 entry days
With traded entry (in plan): 1755 (28.3% coverage)

Selection: `/Users/jamiepark/Cursor/fildi/logs/a357-sample-selection.json` (tagged champion/random; no re-rank on traded subset).

## Haircut 0% (22 weeks)
- Champion − random (traded): **-0.6 bp/wk** · modelled side-by-side: **-0.4 bp/wk**
- Same sign: True · size ratio: 1.38
- Week-difference CI spans 0: True

## Haircut 5% (22 weeks)
- Champion − random (traded): **-1.3 bp/wk** · modelled side-by-side: **-1.2 bp/wk**
- Same sign: True · size ratio: 1.13
- Week-difference CI spans 0: True

## Haircut 10% (22 weeks)
- Champion − random (traded): **-2.1 bp/wk** · modelled side-by-side: **-1.9 bp/wk**
- Same sign: True · size ratio: 1.07
- Week-difference CI spans 0: True

## Modelled vs traded entry (snapped strike)
- Median ratio: 0.919 · IQR [0.702, 1.180]

**Coverage vs plan:** 28.3% → **coverage 28.3% < 60% (pre-registered bar)**.
