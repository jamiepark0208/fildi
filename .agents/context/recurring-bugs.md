# Recurring bugs — every agent reads this before a fix, adds a row after (Jamie 2026-10-28)

> Jamie: "the same bugs are consistently being shown." These are bug **classes**, not one-off tickets. Before fixing anything that
> touches recs, scores, chains or a surface (Model List · Rankings › Options · Structures · Live), check which class it is, fix the
> **producer** (never paper over it in the reader/UI), and make sure a guard catches the class next time. New class → new row.
> Seen again → add the date + case to its row (the count is the point).

## Rules that follow from the rows
1. **No stand-in values.** A missing input is never shown as 0, a default, or "—" as the fix. Find why the producer skipped it and
   make it compute before anything reads it. A reader-side fallback is allowed only to keep the page up, and a check must fail on it.
2. **One engine per decision.** The sold put = `put_recs.py` (`put_recs_daily`). No other code picks a strike for display; readers
   look the engine row up, they never re-pick or "best-guess" a contract.
3. **Join on the contract, not the ticker.** A number attached to a pick must come from the same ticker + strike + expiry + day.
4. **Inputs before consumers.** A step that writes an input runs before every step that reads it, same day. Check `daily.py` order.
5. **Units at the source.** A field keeps one unit everywhere (fractions for pct-of-spot unless the name says `_pct`); never
   "if x < 1.5 multiply by 100" in a reader.
6. **Gate what we trade.** A floor (income, delta, earnings) is measured on the contract sold, not a reference contract.
7. **Later verdicts flow back.** A check that runs later (live quotes, L2) writes its result onto the engine row so every tab agrees.

## Classes
| # | Class | Seen | Root cause (producer) | Guard that catches it now |
|---|---|---|---|---|
| B1 | Stand-in 0 / blank score | 10-28: ON, QCOM, AFRM, CVNA showed score 0; ARM 0 from a calibration "skip" | The option scanner wrote a row only when its *own* strike passed its own floors; the engine picked names it had skipped; reader filled `0`. | `put_recs.py score_picks` scores every pick's own contract after each engine write; `put_consistency.py` WARNs on any ranked pick without `option_score`. |
| B2 | Two pickers for one decision | 10-28: GOOGL board 290 vs ladder ★ 287.5 | Ladder fell back to the old TS `pickBestStrike` max-income strike when the engine contract wasn't in the live chain. | `options-scanner-row.tsx`: no fallback when an engine pick exists; chain refresh always adds the engine's expiry (`engineExpiry` + `getSchwabChainForExpiry`). |
| B3 | Joined by ticker, different contract | 10-28: 12 of 14 Model List puts showed the score of another strike/expiry (GOOGL 57.8 = 307.5 10-30, pick was 290 11-02) | `readLatestOptionRankings` attached `option_score_snapshots` by ticker. | Score now comes from the engine row; the snapshot is used only when strike + expiry match. |
| B4 | Input written after its reader | 10-28: engine used 10-27 put-edge (ARM Q3 → capped 0.12–0.15Δ, 215 vs 217.5) | `put_edge_daily` was persisted only by `house_view.py`, after publish. | `daily.py` step "put edge" before "put recs"; `put_consistency.py` WARNs when engine day > put-edge day. |
| B5 | Unit mismatch | 10-28: Rankings Buffer ~100× on engine rows | Engine rows sent `otmPct` in percent, snapshot rows in fraction. | Engine rows send a fraction (same as snapshots). |
| B6 | Window drops the chosen contract | 10-28: GOOGL 11-02 (Mon) missing from the ladder | Schwab/Yahoo keep the 2 nearest expiries (Yahoo counts same-day). | Same as B2 (engine expiry always fetched). |
| B7 | Gate measured on a reference, not the trade | 10-28: GOOGL 0.27, PLTR 0.19, NVDA 0.22 %/wk passed a 0.30 floor | `min_income` judged the name at 0.15Δ. Band 0.03–0.06Δ (below the 0.05Δ floor) was pickable, and an empty band stepped farther first. | `put_recs.py` + `build_plan.py` gate income at the sold strike; `SE.put_band_floor` keeps picks ≥ 0.06–0.08Δ band; earnings-crossing puts gated. |
| B8 | Later verdict not propagated | 10-28: L2 (live quotes) dropped PLTR/IREN from the Model List; Rankings/Structures still showed them passing | L2 result lived only in `plan_items`. | `verify_plan.live_check_to_engine` writes `live_check` + `pass` onto `put_recs_daily`; Structures/Rankings read it; `put_consistency.py` compares the live-checked pass. |
| B9 | Same decision, two thresholds | 10-28: engine/L1 floor 0.30 %/wk vs L2 live floor 0.35 → MRVL/VRT passed the engine, failed the Model List | L2 used the champion `min_weekly_realistic` (0.35) and relied on a name-income `scale` that was removed with the name-level gate. | `verify_plan.py`: sold puts use the engine's floor; one floor per decision. |
| B10 | Fix that hides the answer | 10-28: after the B2 fix, 47 of 101 engine picks showed no ★ (no saved chain, after-close bid 0, strike outside the 3–25 % window, min-income slider) | Removing a stand-in without guaranteeing the real value is present. | `withEngineContract` puts the engine leg on the ladder (live quote if usable, else the engine's, flagged); the slider never hides it. |
| B11 | Signal shown, never graded | 10-28: Live-tab regime checkpoints had no grade table + no schedule; 40-day backfill = no edge (bearish 77 right / 121 wrong) | Grader existed (`intraday-checkpoint-grading.ts`) but only a manual backfill called it; migration half-applied. | `daily.py` "regime grades" step. Any new signal ships with its grader scheduled. |
| B12 | Morning pick, all-day trading | 10-28: engine priced RGTI 11p at 0.178Δ from 10:23 ET quotes; Jamie sold it at 0.11Δ / $0.10 at 2:50 ET | `put_recs.py` runs once on the morning scan; nothing re-picks on fresh chains. | Open (state.md): re-run the engine at Live checkpoints on warmed chains. |
| B13 | Absolute cutoff excludes a whole segment | 10-28: 22 of ~55 watchlist names (mostly $5–15: ONDS, RGTI, OPEN, USAR, SOFI…) get no put — `bid ≥ $0.10` | A $-floor fits a $200 stock, not a $6 one. | Open: relative tradability (spread / % of strike) — needs a study before replacing S088's nickel rule. |

Also (10-28, Jamie: "excluding data is careless"): a gate never deletes a row — gated picks stay on Rankings with the reason. Prefer
**widening** to dropping (`put_recs.widen_for_income`: step closer ≤ 0.15Δ to reach the floor while the band's worst-5 % ≥ the risk floor).

Check command (run after any change to recs/scores/surfaces): `scripts/watchlist_sync/.venv/bin/python scripts/watchlist_sync/put_consistency.py --strict` (exit 1 on any mismatch).
