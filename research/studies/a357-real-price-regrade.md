# A357 — real-price re-grade (LSE traded entry)

LSE daily OCCs: 3956 · sample plan: 6202 events / 50 entry days
Snapped contracts (eligible): 4600 · with traded entry: 3598 (78.2% of eligible; 58.0% of plan)

## Coverage drops
- no_listed_strike / unsnapped: 1602
- no LSE entry close (±1d, entry day only): 1002
- missing spot/settle: 0

Selection: `/Users/jamiepark/Cursor/fildi/logs/a357-sample-selection.json` (tagged champion/random; no re-rank on traded subset).

## Haircut 0% (42 weeks)
- Champion − random (traded): **+2.8 bp/wk** · modelled side-by-side: **+2.0 bp/wk**
- Same sign: True · size ratio: 1.44
- Week-difference CI spans 0: True

## Haircut 5% (42 weeks)
- Champion − random (traded): **+2.0 bp/wk** · modelled side-by-side: **+1.1 bp/wk**
- Same sign: True · size ratio: 1.72
- Week-difference CI spans 0: True

## Haircut 10% (42 weeks)
- Champion − random (traded): **+1.1 bp/wk** · modelled side-by-side: **+0.3 bp/wk**
- Same sign: True · size ratio: 3.52
- Week-difference CI spans 0: True

## Modelled vs traded entry (snapped strike)
- Median ratio: 0.965 · IQR [0.717, 1.305]

**5% haircut edge (pre-registered):** **underpowered**.
