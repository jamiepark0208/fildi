# S178 — long calls: strike × expiry × exit × skew pairing (2026-11-09, Claude)

**Ask (Jamie 11-09):** maybe the wrong strike or expiry (longer the better), use the skew, pair with sold puts; find which put setups were truly best for long calls, then tighten entry/close.
**Data:** 917 names, Monday entries 2021-02 → 2026-11, 81k entries. Pricing = new surface from 548k real LSEG quotes (`s178_surface_calib.py`), checked against real calls (model ÷ real 0.90–1.08 per DTE bucket). Fills = bid + 23 % of the real spread. Raw tables: `data/s178_out.txt`.

## What the quotes say about skew
- Calls have no wing: call IV is 0.98–1.05× ATM at every Δ and DTE out to 400 days. Puts are 6–20 % rich (0.25Δ ≈ +6 % vs ATM).
- Long-dated IV barely follows iv30. Over 30 days it moves 0.71× at 21–50 DTE and 0.19× at 200+ DTE (level fit gives 0.93→0.45). At low IV, a 240-DTE call costs well above iv30.
- So the skew pays the put seller. A call buyer gets no discount from it at any strike or expiry.

## Results (per $ debit; risk reversal / short put per $ put strike; eras < 2024 / ≥ 2024; two IV-model variants A/B)
| RULE (entry × structure × exit) | mean | eras | vs same-Δ stock | t (lift) |
|---|---|---|---|---|
| All days × 240 DTE 0.30Δ × hold 63 td | −5.1 / −6.1 % | both < 0 | far below | — |
| All days × 60 DTE 0.50Δ × expiry (best all-day) | +15.3 / +14.5 % | −5 / +20 | below (+10 / +30) | — |
| All days × any call × TP 2× / stop −50 % | worse than time exit in every cell | | | |
| Dip (ret20 ≤ −15 %) × 30 DTE 0.50Δ call × expiry | +1.2 / −3.0 % | −12 / +4 | below | 0.2–0.3 |
| Dip × short 0.25Δ put (the put setup) | +1.9–2.2 % | both + | — | 4.0–4.4 |
| Panic (VIX÷VIX3M ≥ 1) × 30 DTE 0.70Δ call × expiry | +45 / +40 % | +35/+44 · +31/+39 | ≈ equal (+45 / +48) | 2.6–2.7 |
| Panic × risk reversal −0.25Δ P / +0.50Δ C × 30 DTE × expiry | +6.1 / +5.9 % | +4.0/+5.7 · +3.7/+5.5 | — | 2.6–2.7 |
| Panic × short 0.25Δ put alone | +2.2 / +2.4 % | both + | — | 6.4–6.6 |
| Low IV pctile ≤ 0.2 × 240 DTE 0.30Δ × 63 td | −1.2 / +7.9 % | model-dependent | below | 1.2 / 2.4 |

Independent events: panic = **15 entry Mondays / 9 months** (n_indep 15 → UNDERPOWERED, not FAIL). All-day and low-IV cells use 69 months of entries.

## Winner pass
- **Winners defined as:** the top decile of P&L per $ in the panic cell (30 DTE 0.70Δ), compared with the bottom half.
- **Pre-entry pattern:** calls won on 11 of 15 panic Mondays and the short put won on 15 of 15. The 4 losing Mondays were all early in a panic, before the low: 2025-03-03, 2025-03-10, 2025-03-31 and 2026-03-09. Winners also came in further below their 50-day average (z50 −1.05 vs −0.86) and had a 5-day return in the bottom fifth (+55 % vs +14 % for the top fifth, train data).
- **Pattern in the low-IV cell:** winners had low iv30/rv20 and were above their 50-day average. That shape disappears once long-dated IV is priced right.
- **Tighten pass** (rule picked on 2021–23, judged once on 2024 →):
  - Low IV + iv ≤ 0.52: test +39 % vs +48 % for the plain cell, so the filter made it worse.
  - Panic + ret20 ≤ 4 %: test +49 % vs +47 %, so it adds nothing.
- **Next rule:** pair the panic risk reversal with S172 timing (enter at the VIX÷VIX3M un-invert, not the first inverted week). Apply it to S173's top-beta names as a paper leg next to the S172 put.

## Verdict
- **RULE "longer-dated calls (120–240 DTE) bought on any day / low IV / dip days, held 21–63 td or exited at TP 2× / −50 %": NO-LIFT.** It fails both eras against shorter calls and against same-Δ stock. Long-dated IV sits above iv30 and the spread is wider. A first pass showed +38 % for low-IV LEAPS; that was a pricing artifact (IV moved 1:1 with iv30).
- **RULE "long calls on the sold-put days (dip / rich IV)": NO-LIFT.** Those days pay the put seller.
- **RULE "panic × 30 DTE 0.50Δ call + 0.25Δ short put (risk reversal) to expiry": UNDERPOWERED-promising.** It makes +6 % vs +2.3 % for the put alone, in both eras, with 15 episodes, on model prices. The call matches same-Δ stock, so it adds leverage, not an option edge.
- **Conflict:** S173b found that RR −0.20P/+0.25C at the un-invert lost money in 66–77 % of trades, measured per $ max risk. S178 uses different strikes and a different capital basis. This is not reconciled; live paper trades decide.

## So-what
- Don't buy LEAPS for edge.
- Don't put stops on long calls.
- Sell puts on dips and rich IV.
- Buy calls only in a market panic, after the un-invert, at 30–60 DTE and 0.50–0.70Δ. Fund them with the 0.25Δ put when you want zero cash outlay.
- Old studies that priced > 50 DTE options off iv30 have the same bias.
