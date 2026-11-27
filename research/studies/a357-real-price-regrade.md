# A357 — real-price re-grade (LSE traded entry) · **INTERIM**

LSE daily OCCs: 3535 · sample plan: 6202 events / 50 entry days
With traded entry (in plan): 3202 (51.6% coverage)

Selection: `/Users/jamiepark/Cursor/fildi/logs/a357-sample-selection.json` (tagged champion/random; no re-rank on traded subset).

## Haircut 0% (38 weeks)
- Champion − random (traded): **+2.1 bp/wk** · modelled side-by-side: **+0.8 bp/wk**
- Same sign: True · size ratio: 2.73
- Week-difference CI spans 0: True

## Haircut 5% (38 weeks)
- Champion − random (traded): **+1.2 bp/wk** · modelled side-by-side: **-0.1 bp/wk**
- Same sign: False · size ratio: 20.70
- Week-difference CI spans 0: True

## Haircut 10% (38 weeks)
- Champion − random (traded): **+0.3 bp/wk** · modelled side-by-side: **-0.9 bp/wk**
- Same sign: False · size ratio: 0.35
- Week-difference CI spans 0: True

## Modelled vs traded entry (snapped strike)
- Median ratio: 0.985 · IQR [0.733, 1.344]

**Coverage vs plan:** 51.6% → **coverage 51.6% < 60% (pre-registered bar)**.
