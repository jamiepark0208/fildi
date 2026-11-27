# A357 — real-price re-grade (LSE traded entry) · **INTERIM**

LSE daily OCCs: 2395 · sample plan: 6202 events / 50 entry days
With traded entry (in plan): 2118 (34.2% coverage)

Selection: `/Users/jamiepark/Cursor/fildi/logs/a357-sample-selection.json` (tagged champion/random; no re-rank on traded subset).

## Haircut 0% (26 weeks)
- Champion − random (traded): **+2.5 bp/wk** · modelled side-by-side: **+1.6 bp/wk**
- Same sign: True · size ratio: 1.58
- Week-difference CI spans 0: True

## Haircut 5% (26 weeks)
- Champion − random (traded): **+1.7 bp/wk** · modelled side-by-side: **+0.8 bp/wk**
- Same sign: True · size ratio: 2.08
- Week-difference CI spans 0: True

## Haircut 10% (26 weeks)
- Champion − random (traded): **+0.8 bp/wk** · modelled side-by-side: **+0.0 bp/wk**
- Same sign: True · size ratio: 28.97
- Week-difference CI spans 0: True

## Modelled vs traded entry (snapped strike)
- Median ratio: 0.930 · IQR [0.701, 1.208]

**Coverage vs plan:** 34.2% → **coverage 34.2% < 60% (pre-registered bar)**.
