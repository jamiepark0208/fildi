# A288 packet — DCF ITM convertibles as equity

**Dry-run 2026-10-28 (live SEC companyfacts refresh)**

| ticker | convert face | conversion price | spot | action |
|---|---:|---:|---:|---|
| SMCI | $4.66B (`ConvertibleLongTermNotesPayable` @ 2026-06-30) | missing (dimensional only) | 35.09 | kept as debt; flag on assumptions |
| PLUG | $0.58B | missing | 1.40 | same |
| MARA | 0 (stale tiny tags only) | — | 7.09 | unchanged |
| AAPL | 0 | — | 347 | unchanged (control) |

**Code:** `financials.convert_debt` + `convert_price`; `engine.inputs` if-converted when spot > cpx. Unit: `dcf/convert_reclass_test.py`.

**Pass:** no-convert names unchanged; names with face+cpx ITM reclass; missing cpx → flag, no silent wrong reclass.
**Next:** when EDGAR instance dims land conversion prices, refresh companyfacts filter already keeps `DebtInstrumentConvertibleConversionPrice1`.
