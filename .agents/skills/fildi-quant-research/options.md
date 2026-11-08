# Options module of fildi-quant-research (Claude 2026-11-08) — how to apply `_study-contract.md` rules 8–10 to options

> Rules (one line each) live in `.agents/dispatch/_study-contract.md`; this file is the options how-to. PLAN-option-structures.md = strategy menu + history.
> Per-stock numbers live in tables (§ 3), per-stock judgment lives in stock notes (§ 9). Agents get defaults + the right to re-assess (§ 6.0).

## 0. Order of work (every option question)
1. **Market state** (§ 5.1) → which families are allowed today and at what size.
2. **Term structure** of this stock (§ 5.2) → richest / cheapest tenor.
3. **Skew** of this stock at that tenor (§ 4) → richest / cheapest leg.
4. **Move distribution** (§ 7) → which move buckets the market under/over-prices for this stock.
5. **Structure** (§ 6) = buy the cheap buckets/legs, sell the rich ones, defined max loss.
6. **Stock params + notes** (§ 3, § 9) → stock-specific entry, strikes, TP, stop, time stop, fill.
7. **Price with real quotes** (§ 1) → grade vs the fair comparator (§ 8).

## 1. Pricing (contract rule 8): real quotes, and if missing, **source them** — never settle for a model verdict
Order when a leg has no real quote: (1) our tables (§ 2) → (2) fetch it (§ 2 sources, cheapest first, sized in calls/rows) → (3) the stock's own fitted surface that day (`optlab.stock_surface_daily`) → (4) only if 1–3 are impossible: model, tagged `priced_by='model'`, share printed, and the gap goes into the fetch queue. Every trade row carries `priced_by`.
Model repricing is right only for stress/scenario (future prices don't exist) and as a fair-value benchmark.
## 2. Real option data — sources (check here before ever saying "we don't have it")
| Source | What | Depth | Cost to fill |
|---|---|---|---|
| `option_chain_history`, `optlab.skew_survey` (Schwab) | full chains bid/ask/IV/Δ/OI | 807 / 638 names, 2026-10-08→ (grows daily) | free, nightly |
| `optlab.lseg_opt_daily` (LSEG RICs) | per contract bid/ask/mid/IV daily | 307 names 2019-12→ but only ~2 contracts/name/day (picked strikes) | **expand**: expired-RIC history, 1 code = whole life, 10k codes/day; needs Workspace open (proxy :9000) |
| London Strategic Edge `/v3/export?market=us_options&symbol=<OCC padded, e.g. "AAPL  251219P00230000">` | every trade, OHLCV + trade count, 1m/1d | all names, 2025-10→ | 60 calls/min ≈ 86k contracts/day; **no IV field → compute IV from the 1m trade price vs the 1m stock bar** (same source). Live chain `/v3/options/chain?underlying=` has IV/greeks but is today only |
| Polygon free option aggs | per contract daily/minute bars | 2 y | 5 calls/min ≈ 7k/day — gap filler |
| tastytrade | IV rank/percentile/IV per expiry snapshots (`tasty_metrics_daily`), server-side backtester | 2026-10-24→ snapshots | free |
| WRDS | 279 libraries (list 10-24: research/sources/a263/wrds-libraries.txt). **OptionMetrics not in the entitlement** (only `optionmsamp_*` 2014 samples); `cboe*` = index/VIX data; TAQ = stocks. Full IvyDB = ask the university library to add it | — | — |
Plan of record (A192 S3): LSE per-contract backfill 2025-10→ with computed IV for the liquid universe (≈ 300k contracts ≈ 4 days) + LSEG expired-RIC backfill 2019→ for ≥ 150 names (≈ 65k codes ≈ 7 days) → per-stock surfaces back to 2019.
## 3. Stock-specific parameters — what must not be a global constant
Rule (contract 9): a threshold applied to every stock must be a **percentile of that stock's own history** or a **stock-measured quantity**, shrunk toward its cluster (sector × vol tier) when the stock has little data: `p_used = (n·p_stock + k·p_cluster)/(n + k)`, k = 20 obs. Global constants allowed only for account policy (max items, collateral rules) and data sanity (IV_SANE).
Home: `optlab.stock_params_daily` (one row per ticker × date; built nightly after S1). Agents read it; never retype a number into a script.

| Today (hardcoded, all stocks) | Where | Stock-specific replacement |
|---|---|---|
| Market-wide skew ratio per (side, DTE, Δ bucket) | s076 `Pricer`, s075, structure_vec_engine | the stock's own surface (§ 4) |
| Strike by fixed Δ: CSP 0.20 / 0.09, spreads 0.25/0.10, long 0.40, debit 0.50/0.25 | s076 `legs_for`, rules.py `PUT_TARGET_ABS_DELTA` | strike at a quantile of the stock's **own** move distribution in implied-σ units (§ 7); Δ is the output, not the input |
| IV/RV gate ≥ 1.15 sell / ≤ 0.95 buy | s076 `fit`, structures.py `MORE_IVRV_*` | stock's IV/RV **percentile** vs its own 1–3 y (biotech IV is always > RV; a fixed 1.15 always passes it) |
| Stop −50 % / 2× credit | structure_vec_engine `EXITS`, S166 | per structure × cluster from Part X path study: stop where P(recover) from that loss on this stock's paths < 25 % |
| TP 50 % / 25 % | same | per structure × cluster from Part X (first-touch curve) |
| Time stop 21 DTE | same | per structure from Part X |
| Fill bid + 23 % of spread | structures.py `FILL`, s076, engine `FILL_FRAC` | stock's measured spread % per Δ/DTE bucket from chain_history × RH fill fraction |
| Strangle margin 0.2·S | s076 `capital` | Reg-T formula per leg |
| Earnings: fixed Δ (0.10/0.07) | rules.py `PUT_EARNINGS_ABS_DELTA` | stock's realized earnings move ÷ implied move (earnings_moves) |
| DTE grid 7/30/45 | engine `DTES` | expiries the stock actually lists with OI ≥ floor |
| MIN_WEEKLY_INCOME_PCT 0.30 | rules.py | keep (account policy) |
Audit command for new code: any numeric literal compared with a per-stock quantity in a study script needs a comment `# global: <reason>` or it is a review finding.

## 4. Measuring skew (bullet 1b: is 10/25 Δ optimal? — no, it's the reporting convention, not the measure)
Problems with raw 10/25 Δ points: 10 Δ quotes in single names are wide/stale; Δ itself depends on the vol you are measuring; two points ignore curvature; absolute skew levels differ by stock forever (a high-skew stock is not "rich" just because its skew is high).
**Measure (per ticker × date × expiry):**
1. Inputs: OTM options only (puts below forward, calls above), forward from put-call parity (handles dividends/borrow), drop quotes with spread > 50 % of mid or OI < floor.
2. Fit the smile in standardized moneyness `x = ln(K/F)/(σ_ATM·√T)`: `IV(x) = a + b·x + c·x²`, weights 1/spread² (SVI later if the quadratic misfits). Outputs: **level a, slope b (skew), curvature c (wings)**, fit RMSE.
3. Interpolate to constant maturity 30/60/90 d (total variance, linear in T). Report 25 Δ RR and 25 Δ BF from the fit for comparability; 10 Δ only when quoted with OI ≥ floor.
**Rich/cheap is relative, two ways:**
- vs **own history**: percentile of b and c in the stock's last 1–3 y (needs history → LSEG puts now, S3 backfill later); cross-stock rank only within cluster.
- vs **what the stock actually does**: realized downside vs upside (60 d semivariance ratio, realized skewness, empirical payoff of a 25 Δ put vs its price over past windows). A skew is rich when the put wing's price exceeds the stock's own historical put payoff for that wing.
Only "rich vs both" earns a sell-leg flag; "cheap vs both" a buy-leg flag.

## 5. Selection funnel
### 5.1 Market state (sets allowed families + size, before any stock)
Inputs: SPY vs 200 d, VIX level percentile, VIX term (VIX/VIX3M), breadth, credit (cds_daily). States: calm-up / calm-chop / stressed / panic (inverted VIX term).
Defaults: short premium full size in calm states, half in stressed, none new in panic (buy cheap hedges instead). Long premium favored when VIX percentile low and term steep. Each state's rule is a hypothesis graded in BOARD.
### 5.2 Term structure (per stock)
IV by tenor (from § 4) vs (a) the stock's HAR realized-vol forecast at that tenor and (b) its own percentile. Strip earnings variance first (ex-event IV) or every earnings month looks "rich front". **Sell the tenor where IV − forecast is widest; buy where narrowest.** Calendar/diagonal only when the gap between tenors is in the stock's own top/bottom decile.

## 6. Structure cards (defaults; § 6.0 says how to override)
### 6.0 Agent latitude
Defaults below are the **starting cell**, not the answer. An agent may change any default for a stock if it (1) states the stock param or note that justifies it, (2) shows the default cell's result next to the changed one, (3) picks on train, verifies on test. No silent changes; no tuning on test.
Every structure gets the same effort: tuned DTE/strike/exit grid (S076 lesson: only CSP was tuned, others ran naive).

| Structure | Purpose | Enter when (all per-stock) | Strikes (default → stock-specific) | Close: TP / stop / time | Fair comparator |
|---|---|---|---|---|---|
| Cash-secured put | sell rich put wing, own the stock cheap | put wing rich vs both (§ 4); IV/RV pct ≥ 60; state not panic | short at own-move q10 (≈ 0.09 Δ today) | TP from Part X (default 50 %); stop: none or Part X; time: hold | T-bill + stock at strike |
| Put credit spread | same, defined risk / less BP | as CSP, and margin-limited | short q10, long at the next cheap strike (wing curvature cheap) | Part X; default TP 50 %, stop 2× credit | CSP per $ BP |
| Covered call | sell rich call on held shares | call wing rich vs own; no breakout setup | short at own up-move q85 | TP 50 %; roll rule | stock held |
| Iron condor | sell both wings in range | both wings rich, IV/RV pct ≥ 70, no event, range state | q10 / q90 shorts, wings cheap | TP 25–50 %, stop Part X | CSP + CC per $ BP |
| Long call | directional, cheap vol | term/skew cheap (call side), view up, implied move < own forecast | ~0.40–0.60 Δ; nearest liquid | TP at view target; stop = thesis broken (level), not % | Δ-stock on same debit (S167 lesson) |
| Bull call debit | moderate-up view (§ 7) | up bucket +0.5…1.5 σ underpriced | long ATM-ish, short at view target | TP 75–90 % of width; no % stop (S166: 66 % of stopped would hit full loss anyway, 22 % recover — decide by Part X) | Δ-stock same debit, long call |
| Risk reversal | rich put skew + up view | put skew rich vs both, call wing cheap | short put q10, long call q75 | thesis/level based | stock |
| Long put / put spread (hedge) | cheap protection | put skew **cheap** vs own history; state calm (hedges are cheap before stress) | 0.20–0.30 Δ | hold to event/expiry; judge by drawdown cut | uncovered book drawdown |
| Calendar / diagonal | sell rich front, own back | front − back IV gap in own top decile, ex-event | ATM / PMCC deep ITM back | TP 25 %; close before front expiry | — |
| Long straddle/strangle | buy underpriced big-move buckets | implied move < own conditional forecast; pre-catalyst | ATM / 25 Δ | close after event or at 2× | — |
Each card must record in its result row: **entry snapshot** (state, term gap, skew pct, IV/RV pct, own-move quantiles, spot vs levels) + **daily path** (mark, Δ, IV) so exits can be studied after the fact (S166 lesson).

## 7. "Moderate move" framework (bullet 6: no right answer → price buckets, don't predict a number)
1. Express every move in the stock's **implied-σ units**: `z = ln(S_T/S_0)/(IV·√T)`.
2. Buckets: crash (< −1.5), down (−1.5…−0.5), flat (−0.5…+0.5), **moderate up (+0.5…+1.5)**, big up (> +1.5). Mirror for down views.
3. **Market's odds**: bucket probabilities from the stock's fitted surface (risk-neutral, Breeden-Litzenberger on the fit).
4. **Our odds**: the stock's own empirical bucket frequencies, conditioned on today's state (trend, IV/RV pct, term gap, skew pct, distance to resistance/target, catalyst), shrunk to cluster.
5. Edge = our odds − market odds per bucket. A structure is a payoff over buckets: buy the underpriced buckets, sell the overpriced ones; bull call debit = buys "moderate up".
6. Risk control, not prediction: defined max loss per trade, size so a wrong bucket call costs ≤ the plan's per-trade risk, and **grade the bucket odds** (Brier per stock/cluster; calibration plot). Odds that don't beat the market's on test → that state carries no edge → no trade.

## 8. Grading
`_study-contract.md` rules 1–7 (fill, comparator, power, leak, halves, inputs, same job). Option-specific comparator per card in § 6.

## 9. Stock notes (save context per stock; Breakdown › Notes)
- **Before** any option work on T: `scripts/stock_notes.py show T` + read T's row in `optlab.stock_params_daily`.
- **After**: ≤ 2 notes, one fact each. Option kinds to use: `character` (e.g. "put skew top-decile 80 % of days; CSPs priced rich structurally — judge vs own pct"), `earnings` (realized/implied ratio), `backtest` (structure × cell result with study id), `lesson` (a stock-specific override that worked/failed, with numbers).
- Notes are history and judgment; numbers that change daily belong in stock_params, not notes.

## 10. Pre-flight
Reviewer checks `_study-contract.md` 1–10 on every option dispatch; rules 8–10 are explained above (§ 1–3, § 6).
