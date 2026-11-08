# Plan: rank every major option structure (A192) — v3 (Claude 2026-11-07; v2 2026-10-19)
> Jamie 10-19: rank the famous structures (straddles, iron condors, …), each with a description, the regimes it suits, and its own
> ranking. Efficient, fast, verified, and less confusing than today's 100+ names per list. v1 → red-team → v2 → Phase 0 → **v3 (§ 7 overrides §§ 2, 4, 5 where they differ)**.

## 0. What already exists (reuse, don't rebuild)
| Piece | Where | Use here |
|---|---|---|
| Strategy Library (strategies / strategy_trades / strategy_equity + runner, 8 strategies) | `analysis/strategy_lib.py`, A175/A176 | each structure = one library strategy (one home) |
| Weekly simulator, 79k ticker-weeks 2020→, IV30/60 put+call | S045 / S059 harness, `lseg_research.daily_history` | price any structure point-in-time |
| Real option prices | `optlab.lseg_opt_daily` (LSEG mids, 2020-12→, 3.5k RICs, mostly puts), `optlab.bars` (Polygon puts 2024-10→), `option_chain_history` (Schwab full rows, 381 names, **only 2026-10-08→**) | fidelity checks + skew calibration |
| Ranking pattern | `put_edge.py` (factors → quintile → holdout pnl/breach) | same pattern per structure family |
| Grading + drift | `forecast_ledger` (`sim_put_otm`), `put_edge.drift`, `house_view` coherence gate | add `sim_<structure>` questions |
| Prior evidence | S020 (spreads/strangles/straddles lost **as replacements** for your CSPs), S018 (earnings moves priced 1.5× too high, not persistent per name), S049/S054 (panic puts), S057 (index tails overpriced ~2×), S059 (put edge), S061 (covered calls lose vs hold in bull tape), S053 (0DTE lotto fail) | priors + regression tests |

## 1. Structures (16) and when the textbook says to use them
| Family | Structure | Payoff idea | Textbook regime | Our evidence so far |
|---|---|---|---|---|
| Short premium, defined risk | Put credit spread (bull put) | sell put, buy lower put | mildly bullish, IV/RV high | S020: wing cost ~55 % of weekly premium → lost vs CSP on your entries |
| | Call credit spread (bear call) | sell call, buy higher call | mildly bearish / capped | S061: calls lose in bull tape |
| | Iron condor | put spread + call spread | range-bound, IV/RV high, no event | untested |
| | Iron butterfly | short ATM straddle + wings | pinned, very high IV | untested |
| | Jade lizard | short put + call credit spread | bullish-neutral, rich put skew | untested |
| Short premium, undefined | Cash-secured put | — | have (put edge) | S059 PASS |
| | Covered call | — | have | S061: only on held shares |
| | Short strangle | sell OTM put + OTM call | range, IV/RV high | S020: −$3.7k vs CSP, worst week −$3.2k |
| | Short straddle | sell ATM put + call | pinned, extreme IV | S020: −$46.9k |
| Long premium | Long call / long put | directional | strong trend + cheap IV (IV/RV < 1) | untested (prior: VRP → negative EV on average) |
| | Long straddle / strangle | buy vol | IV/RV low before a catalyst | S018 says earnings moves overpriced → expect FAIL through earnings |
| | Debit call spread / debit put spread | cheaper directional | trend + moderate IV | untested |
| Time / term | Calendar (sell front, buy back) | front decays faster | inverted term (front IV > back) | S059: term slope not predictive for puts |
| | Diagonal / PMCC | long deep ITM back call + short front call | bullish, low back IV | untested |
| Hedge | Protective put / collar | cap downside | after big gains, credit wide (S028) | judge by drawdown cut, not pnl |
| | Risk reversal | sell put, buy call | bullish, rich put skew | untested |

Each structure page (Strategy Library) gets: plain description, payoff sketch, max loss/gain formula, the regime card above, **our test result**, and today's ranked names.

## 2. Engine (fast: everything nightly in Python, the API only reads a table)
1. **One leg pricer**: legs = [(type, strike rule, expiry rule, ±qty)]. Strike rules by delta or σ-distance (as S045). BS at a **per-leg IV = ATM IV × skew(moneyness, DTE)** from Phase 0. Term: IV30 / IV60 interpolation.
2. **Fills**: per leg, bid + 23 % of the spread (your measured RH fill, state.md); spread % by moneyness/DTE from Schwab chains. A 4-leg structure pays 4 spreads; that's often the whole edge (S020).
3. **Outcome per trade**: pnl ÷ capital at risk (max loss for defined risk; strike for CSP; RH margin rule for undefined, IRA = cash-secured only), P(max loss), worst week. Hold to expiry (S017: early exits didn't help CSPs) + one 50 %-take variant for spreads.
4. **Ranking per family** (not per structure, to limit multiple testing): short-premium family reuses the S059 factors; long-premium uses the same factors with reversed sign + trend; time family uses term slope. Quintile → holdout pnl/risk and P(max loss) (`structure_calibration.json`).
5. **Speed**: numpy over 79k weeks × 16 structures ≈ 1.3 M priced trades; target < 60 s nightly. Live: only focus names priced with Schwab quotes (≤ 200 contracts per call, already built).
6. **Output table** `watchlist_sync.structure_rank_daily (as_of, structure, ticker, legs jsonb, credit, max_loss, exp_pnl_risk, p_max_loss, quintile, regime_fit)` → `GET /api/options/structures` → Options › **Structures** tab.

## 3. Board (fix "too many tickers")
- Top: **"Today's regime → best structures"** card from `house_view` (e.g. VIX 20, IV/RV rich, semis −15 %, credit normal → "short premium, defined risk; ≤ 2 per sector"). Only structures whose holdout result passed are shown.
- Per structure: **≤ 5 names**, expected pnl/risk, P(max loss), "vs plain CSP on the same name" (so the cost of protection is visible, S020).
- Coherence: one structure per ticker per day; never long-vol and short-vol on the same name; trim names get no bullish structures; account fit (cash, IRA rules) shown per row.

## 4. Verification (every phase, pre-registered)
1. **Simulator fidelity**: for focus names, sim price vs real Schwab mid on the same day; error budget ≤ 10 % of credit (≤ 15 % for 4-leg). Fails → structure stays "provisional".
2. **Real-price replication**: put-side structures re-run on `optlab.lseg_opt_daily` real mids (2020→); sign must match the sim.
3. **S020 regression**: on your 342 entries the engine must reproduce S020's sign for spread / strangle / straddle vs CSP.
4. **Holdout gate**: adopt a structure only if holdout (2024-07→) top quintile pnl/risk > 0 with weekly t ≥ 2, both halves, Holm-corrected across the 16; else "described, not ranked".
5. **Live grading**: Monday sim of each adopted structure → `forecast_ledger` (`sim_<structure>`), drift auto-demote after 6 weeks (same rule as put edge).
6. **Smoke test first** (memory rule): 5 names, hand-checked legs/prices before any full run.

## 5. Phases and stop rules
| Phase | Work | Gate / stop |
|---|---|---|
| 0 (DONE 11-07: FAIL 2.69 vol pts, see § 7) | **Skew + spread survey**: store full Schwab chains (all strikes, 7–45 DTE) for the ~120 most liquid names daily; probe LSEG for 25Δ IV history (1 request); fit skew(moneyness, DTE, IV level) | skew model holdout error ≤ 2 vol pts; if LSEG has 25Δ history, backfill and start Phase 1 early |
| 1 | Leg pricer + fills + S020 regression + fidelity check on 5 names | fidelity ≤ 10 %; S020 sign reproduced |
| 2 | 16 structures × 79k weeks, family factors, holdout | Holm; expect most long-vol to FAIL (VRP prior) — that's an answer, not a bug |
| 3 | `structure_rank_daily` + API + Structures tab (Cursor) + regime card | API p95 < 200 ms (table read); ≤ 5 names/structure |
| 4 | Live sim grading + drift | 6 weeks → first demote/keep decisions |

## 6. Red-team log
**v1 → v2 (Claude 10-19):**
1. *Wings priced at ATM IV* (probe: ~12Δ put IV ≈ 1.11× ATM, calls 1.03×) → condors/spreads would look too cheap to buy/too rich to sell → Phase 0 skew survey + "provisional" until fitted.
2. *Multiple testing*: 16 structures × factors → family-level factors + Holm.
3. *Fills dominate multi-leg*: per-leg fill haircut from real spreads; show "vs CSP".
4. *Board overload*: regime card + ≤ 5 names per structure + only passing structures.
5. *Account limits*: IRA cash-secured only; undefined-risk structures flagged by account.
6. *S020 already said no* for replacements → keep it as a regression test; new question is "on their own entries/regimes", reported vs CSP.
**v2 → v3 (after Phase 0):** re-check skew fit, fill model, and whether any long-vol structure is worth Phase 2 at all.

**v2 → v3 (Claude 11-07, Phase 0 result):** see § 7.

## 7. v3 (after Phase 0, 2026-11-07)
**Phase 0 result** (A192 packet, ebb2ab24): best skew model (pooled quadratic + per-ticker shrink) holdout MAE **2.69 vol pts** (0.05–0.15Δ 3.42 · 0.15–0.30Δ 3.14 · 0.30–0.45Δ 2.06) → FAIL vs ≤ 2. Median quoted spread, % of mid: 0.05–0.15Δ **67–91 %**, 0.15–0.30Δ **28–35 %**, 0.30–0.45Δ **16–19 %**. SPY/QQQ/IWM were missing from the holdout (survey bug, fixed 11-07).
**So what:** for any structure with a wing, the fill cost is bigger than the skew error. The model can't be the price source; real quotes have to be.

Changes vs v2:
1. **Price source, in order:** (a) live board → that day's stored chain (`optlab.skew_survey` / `option_chain_history`), no model; (b) backtest 2025-10→ → **LSE OPRA trades + greeks** (London Strategic Edge, real calls and puts, strikes snapped via /v3/pairs as in A357); (c) backtest 2020-12→2025-09 → skew model with an explicit ±2.7 vol pt band (each trade priced at model, model−band, model+band; a structure must win at the unfavourable edge).
2. **Fills:** per leg at the measured spread table above (cross for the gate, mid+¼ reported), RH bid + 23 % of spread for sells / ask − 23 % for buys as the "realistic" line. 4 legs = 4 spreads, no netting discount.
3. **Wing floor:** no leg below 0.15Δ in backtests (0.05–0.15Δ fills are guesswork at 67–91 % spread). Condors/flies/lizards use ≥ 0.15Δ long wings; that makes them dearer, and that's the honest test.
4. **Dropped before Phase 2 (answered already):** long straddle/strangle through earnings (S018: moves priced 1.5× too high); long index wings (S057: ~2× overpriced). Listed as "described, not ranked" with the study id.
5. **Phase 1 gate (replaces "fidelity ≤ 10 %" vs sim):** on the 2025-10→ overlap, model-priced vs LSE OPRA real price per structure: error ≤ 15 % of credit (2-leg) / 20 % (4-leg), else that structure's pre-2025-10 backtest is not used for ranking (real-price window only, flagged short-history).
6. **Phase 2 gate:** unchanged (top quintile pnl/risk > 0, weekly t ≥ 2, both halves, Holm across structures) but judged on (i) the real-price window alone and (ii) the full window at the unfavourable band edge; both must pass. Real-price window is ~13 months → expect most structures "underpowered" — report N_eff and minimum detectable effect, don't call that a FAIL.
7. **Structures engine = A359 conditional engine** (one home): legs priced by `SpreadCalibration` + LSE OPRA marks, entries on regime match. No second simulator.
8. **Re-fit check:** re-run `analysis/skew_fit.py` after 10 more survey days incl. SPY/QQQ/IWM — only to confirm the ±2.7 band, never to re-open the Phase 0 bar.

**Next:** Phase 1 → Cursor after A359 fix4 lands (same engine file, one code edit at a time). Spec: leg pricer on the A359 engine + LSE OPRA call/put marks for 5 names × 20 weeks, S020 regression sign, gate 5 above.

## 8. v4: full strategy menu, one shared engine (Jamie 2026-11-07)
**Need (Jamie):** "Covered calls and iron condors are not the only backtests and trade ideas we need to improve entry/close conditions for … a lot of these legs and market views are similar, so optimise the studies so we don't do duplicate work." Plus Structures should explain every trade type the way the tastylive *Options Strategy Guide* (2023, `~/Downloads/options-strategy-guide.pdf`, 31 strategies) does.
**Licence note:** the guide is © tastylive, reproduction prohibited. We copy the **layout** (header strip, setup legs, payoff zones, ideal / not ideal, vol, expiry, defence, takeaways), not their text, art or brand. Our cards use our own words, payoff diagrams drawn from `legs.ts`, and add what the guide lacks: **our backtest verdict + a live pick**. Their numbers (DTE, IV, POP, profit target) are the *claims we test*, cited as "guide default".

### 8.1 The 31 strategies (guide defaults = baseline cell to test)
| # | Strategy | Family | View | IV | DTE | Guide POP | Guide profit target | In Fildi catalog |
|---|---|---|---|---|---|---|---|---|
| 5 | Covered call | F | Bullish | High | 45 | 50% to 70% | 50% of Max Profit | covered_call |
| 6 | Long call vertical | D | Bullish | Any | 45 | 40% to 60% | 50% of Max Profit | bull_call_spread |
| 7 | Call ZEBRA | D | Bullish | Any | Any | 50% | 25% of Debit Paid | — |
| 8 | Poor man's covered call (call diagonal) | E | Bullish | Low | 45 to 60 | 50% to 60% | 50% of Estimated Max Profit | (builder pmcc only) |
| 9 | Call calendar | E | Bullish | Low | 45 | N/A | 10-25% of Debit Paid | calendar |
| 10 | Call butterfly | D | Bullish | Any | 15 to 45 | 20% to 40% | 25% of Long Spread Width | — |
| 11 | Big lizard | B | Bullish | High | 45 | 60% to 80% | 25% Max Profit | — |
| 12 | Covered put | F | Bearish | High | 45 | 50% to 70% | 50% of Max Profit | — |
| 13 | Long put vertical | D | Bearish | Any | 45 | 50% to 60% | 50% of Max Profit | bear_put_spread |
| 14 | Put ZEBRA | D | Bearish | Any | Any | 50% | 25% of Debit Paid | — |
| 15 | Poor man's covered put (put diagonal) | E | Bearish | Low | 45 to 60 | 50% to 60% | 50% of est. max profit | — |
| 16 | Put calendar | E | Bearish | Low | 45 | N/A | 10-25% of Debit Paid | — |
| 17 | Put butterfly | D | Bearish | Any | 15 to 45 | 20% to 40% | 25% of Long Spread Width | — |
| 18 | Reverse big lizard | C | Bearish | High | 45 | 60% to 80% | 25% Max Profit | — |
| 19 | Put front-ratio | B | Omnidirectional | High | 15 to 45 | 60% to 80% | 50% of Credit Received or 25% of Long Spread Width | — |
| 20 | Call front-ratio | C | Omnidirectional | High | 15 to 45 | 60% to 80% | 50% of Credit Received or 25% of Long Spread Width | — |
| 21 | Put broken-wing butterfly | B | Omnidirectional | High | 15 to 45 | 60% to 80% | 50% of Credit Received or 25% of Long Spread Width | — |
| 22 | Call broken-wing butterfly | C | Omnidirectional | High | 15 to 45 | 60% to 80% | 50% of Credit Received or 25% of Long Spread Width | — |
| 23 | Call broken-heart butterfly | C | Omnidirectional | High | 45 | 60% to 80% | 25%-50% of Long Spread Width | — |
| 24 | Put broken-heart butterfly | B | Omnidirectional | High | 45 | 60% to 80% | 25%-50% of Long Spread Width | — |
| 25 | Short strangle | A | Neutral | High | 45 | 60% to 80% | 50% of Max Profit | short_strangle |
| 26 | Short straddle | A | Neutral | High | 45 | 50% to 60% | 25% of Max Profit | short_straddle |
| 27 | Iron condor | A | Neutral | High | 45 | 60% to 80% | 50% of Max Profit | iron_condor |
| 28 | Dynamic-width iron condor | A | Neutral | High | 45 | 60% to 80% | 50% of Max Profit | — |
| 29 | Iron fly | A | Neutral | High | 45 | 60% to 80% | 25% of Max Profit | iron_fly |
| 30 | Short naked put | B | Neutral-Bullish | High | 45 | 60% to 80% | 50% of Max Profit | csp |
| 31 | Short put vertical | B | Neutral-Bullish | High | 45 | 60% to 80% | 50% of Max Profit | put_spread |
| 32 | Jade lizard | B | Neutral-Bullish | High | 45 | 60% to 80% | 50% of Max Profit | jade_lizard |
| 33 | Short naked call | C | Neutral-Bearish | High | 45 | 60% to 80% | 50% of Max Profit | — |
| 34 | Short call vertical | C | Neutral-Bearish | High | 45 | 60% to 80% | 50% of Max Profit | call_spread |
| 35 | Reverse jade lizard | C | Neutral-Bearish | High | 45 | 60% to 80% | 50% of Max Profit | — |
Fildi catalog today: 17 entries (13 of these 31 + long call/put/straddle/strangle, collar). Missing 18: ZEBRAs, PMCP, put calendar, call/put butterflies, big / reverse big lizard, covered put, front-ratios, broken-wing and broken-heart butterflies, dynamic-width IC, naked call, reverse jade lizard.

### 8.2 Dedup: 6 families, 2 stages, parity skips
Families (what has to happen for the trade to win):
- **A. Neutral, short premium both sides** (strangle, straddle, IC, dynamic IC, iron fly) — anchor **iron condor**.
- **B. Neutral-bullish, short put risk** (naked put / CSP, put vertical, jade lizard, big lizard, put front-ratio, put BWB, put broken-heart) — anchor **CSP, already tuned** (S059 / S087 / S088): reuse its entry signals as-is, only test the payoff shape.
- **C. Neutral-bearish, short call risk** (naked call, call vertical, reverse jade, reverse big lizard, call front-ratio, call BWB, call broken-heart, covered call) — anchor **short call vertical**; seed entries with S046 / S061 call signals.
- **D. Directional debit** (long call / put verticals, ZEBRAs, call / put butterflies) — anchor **debit vertical**; entry = a direction signal (S126: our market-direction call failed; S158/S159 dips weak) → expect weak, test once per direction.
- **E. Term structure / low IV** (call / put calendar, PMCC, PMCP) — needs a per-expiry IV term structure (LSEG = iv30 only → `option_chain_history` / LSE OPRA 2025-10→); anchor **call calendar**; real prices only (the fixed-IV pricer gave +155 %, S062).
- **F. Stock + option** (covered call, covered put, collar) — graded vs holding the stock; covered call ≈ short put by parity → **graded on family B results**, not re-run.

**Stage 1 (per family, anchor only):** full grid on the anchor = entry filters × DTE {7, 30, 45} × short |Δ| × exits {hold, TP 25 / 50 %, stop 2× credit, close 21 DTE}. The guide default (45 DTE, 50 % TP — 25 % for straddle / iron fly) is one pre-registered cell, so the guide's own claim is graded. Train 2021–23, test 2024→.
**Stage 2 (variants):** inherit the anchor's top-3 train cells (entry + exit); vary only shape (wing width, ratio, broken wing). ~3 cells per variant instead of ~200 → about 85 % fewer runs. A variant beats its anchor per $ BP in test or it's dropped.
**Parity skips (no run, note the twin):** covered call ≡ short put same strike; covered put ≡ short call; ZEBRA ≈ 100 shares with a debit floor (graded vs stock + married put); put credit vertical ≡ call debit vertical same strikes; iron fly = short straddle + wings (fly run gives both).
**One leg-mark cache:** each (ticker, day, side, |Δ| bucket, DTE bucket) is marked once (S075 skew pricer now; OPRA marks where present) and every structure reads it, so 31 strategies cost the same data pass as one. Managed exits re-mark from the cache daily.
**Grading (all families):** mean per $ BP per day, month-block t, worst 5 %, max DD, win %, exit-reason mix; vs T-bill on BP and vs the family B anchor (enhanced CSP) at the same BP. Must hold at the −2.7 vol pt pricing edge. Win rate never alone.
**Stop rule:** Stage 1 smoke = families A + C anchors + naive-CSP control, 30 tickers, train years. A family whose anchor has no cell > 0 per $ BP net of fills in train skips Stage 2 (variants can't fix a wrong view).

### 8.3 Structures UI (Part C)
Catalog 17 → 31 (+ long options, collar), grouped by the guide's six views. Each strategy opens a card in the guide's layout: header strip (view · IV · DTE · guide POP) → setup legs → payoff diagram from `legs.ts` (green profit / red loss zones, strikes tagged P/C, spot marker) → max profit / max loss / breakeven / profit target / Greeks → how it works (ideal / not ideal) → if IV expands / contracts → at expiry → defence → takeaways → **Fildi evidence** (verdict badge, study id, live vs backtest) → **Build this** (opens the Part L builder pre-filled). Text is ours, ≤ 2 lines per box, method in tooltips (UI style rule).
