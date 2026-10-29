# A288 packet — DCF ITM convertibles (Claude revise 10-28)

**Fixes shipped**
1. Dilution ≥30% shares → zero rsu/opt (BABA ADS gap); convert guarded separately.
2. Dropped convert shares restore face to debt.
3. Skip convert_sh when diluted−basic gap used (ASC 260); ONDS flags skip.
4–5. Vintage-matched XBRL cpx + 10-Q note overrides / per-tranche when XBRL omits cpx.

**Live (engine.inputs)**
| ticker | action | evidence |
|---|---|---|
| BABA | dilution zeroed (≥30%) | was +667M shares / ~26% low FV |
| NET | ITM reclass 2 tr → +14.7M sh, −$3.27B debt | 10-Q cpx 191.34 / 247.67; spot 327.8 |
| AAOI | ITM reclass → +3.0M sh, −$0.13B debt | 10-Q cpx 43.31; spot 76.95 |
| RKLB | ITM reclass → +2.6M sh, −$0.01B debt | 10-Q $13.4M @ 5.13; spot 58.31 |
| ONDS | skip (gap) | face restored; no double count |
| SMCI | kept as debt | OTM vs 55–83 cpx; spot 35 |
| AAPL | unchanged | control |

**Tests:** `dcf/convert_reclass_test.py` ok.
**Verdict:** revise items 1–3 fixed live; 4–5 exercised on ≥3 ITM names via note overrides (XBRL still lacks fresh cpx for SMCI/PLUG).
