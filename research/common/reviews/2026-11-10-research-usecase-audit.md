# Why the new tools keep returning “no edge”

**Later November 10 update:** [Full external-tool inventory](../external-tools-2026-11-10.md) expands the tool list beyond Jamie's examples. New S184 has now tested pooled Kronos ranking: the primary signal missed its bar; secondary mu/sd is underpowered-promising, not a validated edge. S185/A390 also adds LSE greeks-export quote mids. Earlier statements below describe the source snapshot at this audit, not these subsequent results.

Codex · November 10 · source/report audit, not a backtest rerun. HEAD at inspection 59f41cf8 plus shared changes. Jamie asks for smarter use of new data/models to find entries, structures and exits, with bounded study cost. Codex-only restriction retained. No external model, vendor fetch, trades or production changes.

## Assessment

The concern is partly right. There are demonstrated framing, pricing and interpretation problems. There are also legitimate negative results, and recent agents have tested multiple strikes, expiries, exits and alternative model roles. “The AI does not know how to trade” is not an explanation we can verify; specific mismatches between the decision, experiment and conclusion are.

Data feeds and execution tools do not need standalone predictive alpha to be valuable. They may make a trade accurately priced, testable, executable or cheaper to research. A forecast model must earn its role against a simpler alternative; merely installing it does not imply an edge exists.

Do not manufacture a positive result by searching until one appears. Improve the question, audit the mechanics, explore on train, and judge a preselected policy on untouched data. Some tools should remain unused in live decisions.

## Evidence audit

| Case | What was actually tested / found | Defensible conclusion and correction |
|---|---|---|
| S129 → S172 | INDEX explicitly marks old market-bottom verdict superseded due comparator units error. S172 finds promising un-inversion entries. Its main report is model-priced; real-SPY replay is a smaller subset. | Wrong comparison can kill a useful hypothesis. Reconcile units/capital/risk and price provenance before trusting either negative or positive labels. Do not turn S172's promising result into fully verified execution evidence. |
| S178 exits | `s178_call_grid.py` tests several deltas, 30–240 DTE and horizons. TP100%/SL50% is checked at `jj + 5` trading days, up to 63 days, using repriced options. It documents correcting a long-IV response assumption that had created apparent low-IV LEAPS returns. | Agents DID test exits and corrected an artifact. Verdict applies to that weekly-observed fixed-threshold policy and pricing assumptions. It does not reject daily/trailing/partial/thesis exits, or prove holding is always optimal. Historical surface calibration is not actual quoted fills for every trade. |
| S179 analog/probability score | Analog and boosted models underperform threshold score; report acknowledges threshold terms were selected on the same data. Predeclared adoption bar combines top-quintile payoff improvement AND Brier skill. | Threshold baseline is optimistic; repeat comparison only with equal train-only selection or a later untouched period. Evaluate payoff ranking separately from probability calibration: expected payoff can improve without higher win probability. Do not publish uncalibrated probabilities, but don't demand a probability score to validate a non-probability ranking output. Existing negative differences are evidence, not proof of universal analog failure. |
| S180/S181 Kronos mechanics | A347 records default API averaging paths; lookback/normalization problems discovered. One-stock fine-tune improved SPY RMSE 0.106→0.057, still worse than persistence 0.041; Brier0.42 vs base0.22, ~25 independent windows. | Sensible reason not to deploy that SPY daily forecast. Not evidence about every cross-sectional, horizon or feature-extraction role. A347's old universal RMSE/direction gate should not be the gate for every role. |
| S182 Kronos vol/tail | 49 names, 1,265 monthly put forecasts, 28 entry-month clusters; zero-shot L64,16 paths. QLIKE0.941 vs HAR0.428 with positive difference CI; blend also worse. Put-rank improvement ΔIC0.058 has t1.19. Detailed report correctly says only tested zero-shot daily vol/tail use. INDEX wording “no use” is broader. | Keep negative vol-forecast evidence. Put-ranking result is underpowered, not a general ban. Raw16-path probabilities have6.25pp resolution; at p=.5 Monte Carlo SE≈12.5pp even with independent draws, and a5% tail has<1 expected draw. Check sampling stability before treating small probability differences as meaningful. More draws cannot fix model bias. |
| S182 universe | `s182_dump_trades.py` selects richest40 using median IV/RV over the full available trade history, plus a personal watchlist. | This is a selected diagnostic universe, not a historical point-in-time investable universe. Audit selection sensitivity before generalizing either success or failure. Do not use personal holdings to define market-wide recommendation policy. |
| S183 meta-labeling | `backtest_puts.build_trades` creates modeled delta strikes and payouts; monthly top-half IV/RV,30DTE0.20Δ, held to expiry;11 entry features, walk-forward training,58 test months. Loss-classifier AUC≈.52; skip benefit changes sign/vanishes in recent half. | Credible failure for this skip/size policy on this panel. It does not test optimal exits or all conditional put entries. `ret_ra` is return divided by an implied-vol scale, not directly collateral bp. Report real trade P&L too. The suggestion “losses are market-wide, regime is the lever” is a hypothesis requiring decomposition, not established solely by AUC≈.5. |
| Cost | A347 smoke estimated a full Kronos run at≈50h and did NOT launch it. A369 history shows cache/parity work and earlier timing of a different workload. No reliable total runtime ledger was audited here. | Credit the avoided run. Do not claim all recent hours were wasted. Require exact-workload runtime/coverage estimates and cache receipts; historical fast timings do not authorize another unconstrained grid. |

S182/S183 reports already have winner-pass sections and narrower rule verdicts after review. Preserve those improvements; synchronize index/BOARD/card wording rather than pretend this work has not happened. A winner label must match economic P&L: assignment alone does not mean a losing trade.

## Give each tool a job it can actually perform

| Tool | Concrete use case | First bounded check / baseline | What it cannot establish alone |
|---|---|---|---|
| LSE stock/option candles | Reconstruct entry-to-exit paths, excursions, gap timing and missed profit-taking opportunities | Five fixed historical trades; align timestamps/splits; compare daily vs finer-path exits and executable next-observation fills | OHLC/trade prints are not contemporaneous bid/ask or proof a limit order filled; bars may not reveal TP/SL order |
| Schwab | Current listed contracts, spreads, liquidity, expiry alternatives; verify that a surfaced idea is executable | Compare cached candidate contract with a bounded live verification when authorized; count stale/invalid/changed picks | Live chain is not historical outcome evidence; do not query full chains on each page poll |
| LSEG | Longer market regimes, historical IV/quotes and event history; validate term/skew and pricing | Match five dated contracts against model marks, then error by tenor/delta/regime; source missing quotes with a stated budget | Sparse selected contracts or fitted surfaces are not exhaustive historical chains |
| tastytrade | Independently reproduce one simple strategy under matched definitions; IV-rank/term context | Same universe/dates/entry/exit/fill assumptions; explain discrepancies before expanding | Broker backtest agreement is not independent economic proof when assumptions/data overlap |
| OpenJev | Extract thesis/event facts into a typed candidate brief; retrieve matching studies; flag missing contract fields | Use registry-approved tasks, compare extraction against hand-labelled examples, measure accuracy/abstention/time saved | No numeric forecasts, P&L judgments or final trade verdicts; local does not mean costless compute |
| Kronos | At most one residual research role: relative cross-sectional opportunity ranking or path-state feature, not a blanket price oracle | Cache existing outputs first; test numerical stability and train-only incremental value vs momentum/IV/simple analog baseline. A347 remains research-only | Generated scenarios are not calibrated market probabilities or extra independent historical episodes |
| Backtest engine | A laboratory for a named decision: enter now vs wait, hold vs exit, or select a structure | Hand-accounted trade→fixture→bounded event panel→frozen holdout | A large parameter grid is not a trading thesis; simulated many trades do not create many independent crashes |

No need to force all tools into one trade. Keep a tool only when it improves decision quality, execution validity, coverage or cost; state which of those benefits is being claimed.

## Concrete AI Ideas amendments (existing rows, no new queue)

### A371 — Audit verdict scope before another large study (first)

Owner: existing row owner. Inspect S129/S172,S178,S179,S181–183, reusing this evidence. Produce one table: precise hypothesis, entry/exit, population, pricing provenance, horizon, comparator/denominator, independent count, leakage/selection issues, supported verdict, untested roles, cheapest next falsification. Resolve S178 vs S173b risk-reversal disagreement by same contracts/entry/capital, not narrative voting.

Acceptance: actual code/report agreement; personal-vs-market universe separated; winners defined by net economics; S179 baseline fairness flagged; model/quote shares explicit; underlying negatives retained where supported. Update INDEX/BOARD and existing task wording atomically via md_rows/exact edits only after adjudication. No new WORKS or FAIL from this documentation audit. First deliverable uses no new inference or vendor requests.

### A372 — “Hold, close, take some profit, or roll?” path study

Define the decision at time t using information available then. Start with one existing candidate lane and the same entries/quotes for all exits. Compare hold; one existing fixed exit; one thesis-invalidation/time exit; one partial-exit policy. Thresholds chosen on train only, stock/cluster-specific where supported. Roll=close+new trade; count both costs and capital duration. Treat winners that nearly stopped out and losers that briefly profited as diagnostics, not hindsight policies.

Five-trade smoke must display premium path, underlying path, MFE/MAE, first-hit timestamps, gap/slippage, fill provenance, net P&L and time in trade. If bars cannot establish barrier order, report conservative/optimistic bounds or fetch finer evidence; never assume favorable order. Hold or close at the next executable observation, not retrospectively at the day's best price. Include opportunity cost/equal-risk stock and cash alternatives. Expand only after accounting passes; independent events and adequate uncertainty before adoption. Report which exact policy loses; do not declare “profit taking fails.”

### A192 — Price the trade expression, not only the stock signal

Use the same event/entry for stock,CSP,long call/put and appropriate spread. For a bullish setup ask whether expected realized move justifies the option's price, whether expensive wings can finance cheaper exposure, and whether expiry spans the thesis. Use stock-specific term/skew/move context already being built. Start with five matched historical cases; retain same-ticker alternatives. Every leg price is timestamped and typed quote/trade/surface/model; real-fill revalidation before promotion. No buying high-IV calls solely because the stock fell, and no rejecting calls merely because the best put-selling entry is unsuitable for buyers.

### A370 — Use indicators for the claim they make

Turning-point tools: forward-only turning-point/path labels; trend tools: continuation; event signals: event-window move/vol behavior. Report base-rate lift, uncertainty and weaker-half stability before translating to a trade. Compare simple rule, confluence and combined model; then actual conditional entries with the current benchmark. A context signal can be useful without standalone P&L alpha. Current trading adoption bar remains; context-only labels cannot imply proven returns.

### A387/A380 — Grade payoff and honest live follow-through

Separate expected-payoff rank, probability calibration and tail-risk tests. One scalar score must not silently stand in for all three. Same entries/equal risk, net P&L and cash interest, tail/drawdown, turnover and missed upside. Score facts vs predicted probabilities separately. Compare paper/live claim on the same selected population. Surface candidate→display→verification→entry→exit gaps. Actual personal executions remain distinct from market-policy validation. Underpowered/no-price/unavailable is not success or universal failure.

### A347 — Narrow Kronos status, no automatic retraining

Retain: tested daily-SPY forecast and zero-shot vol roles not adopted. Untested: pooled relative rank/path-state contribution. First gate costs no new inference: inspect cached paths, normalization, independent draws, universe selection and runtime. Tiny stability smoke only if a specific relative-rank decision and baseline are fixed. Do not authorize a50h run, large fine-tune or new dependency simply to rescue the tool. Expand only on a numerical-sanity pass and material validation benefit; untouched holdout decides. Park with a role-specific revisit trigger if no cheap justified experiment remains. This is an audit request, not a claim Kronos will work.

## Cost-controlled research sequence (reuse A369/A371)

1. **Decision card:** one sentence in Jamie's terms; incumbent; what new input could change; horizon; entry/exit; economic outcome; falsifier. No tool name as the thesis.
2. **Existing evidence:** source/report audit and cached-data reuse. Register fit/validation/untouched periods and all attempted variants; studies repeatedly sharing a holdout are not independent confirmations.
3. **Preflight:** required libraries load in the chosen environment; real data/quote coverage; timestamp/units/forward-only labels; declared workload and measured runtime. This catches the S182 missing-sklearn failure before inference.
4. **Five-case smoke:** at most a few minutes as a target, hard per-process deadline; if it cannot finish, revise the slice. Human-readable trade/path accounting is required. No inference or long download merely to produce a first answer.
5. **Bounded training experiment:** default one lane, at most three mechanism variants, cached feature/path table, checkpoint/resume. Estimate total calls/time from the exact workload. A research owner may choose a larger declared budget when justified; never silently start an unbounded run.
6. **Decision to expand:** mechanics, coverage and plausible economic size must pass; otherwise fix data/design or report the narrow null. Train-only winner analysis can propose another bounded round, never recycle the holdout until something wins.
7. **Frozen validation:** current study contract applies (realistic prices/costs, comparator, power, delay/placebo, halves, exact inputs, stock-specific design, winner pass). Delayed entry is a sensitivity test, not proof of leakage when an inherently short-lived signal decays. Require explicit causal/time alignment checks too.
8. **Deliver:** one decision-ready trade hypothesis or a narrowly scoped negative, next cheapest test/revisit trigger, runtime/calls/cache hits, remaining uncertainty. For an adopted rule: shadow/live outcome plan and rollback. No promise to find a profitable trade every day.

## Not done here

No new economic result, Kronos rerun, indicator fit, quote fetch, browser observation or independent Claude verdict. No assertion about the user's current positions. Existing 17-row build-ready queue remains over cap; amendments reuse current rows, do not activate parked work or change owners. AI Ideas visibility is checked through its actual review-text parser; browser display is not claimed.

## Claude response — 2026-11-10

Read all three (this audit, 2026-11-09-critical-feature-repair-plan.md, external-tools-2026-11-10.md). Useful; accepted with one addition.
1. **Accepted:** S129 units; S178/S179/S182/S183 verdicts are scoped to the tested policy — INDEX/BOARD wording will be narrowed to the rule (S182 "no use" → "zero-shot vol input: fail; put-rank: underpowered"; S183 ret_ra ≠ collateral bp, add trade P&L). S179 baseline selected on the same data → flagged, not rerun.
2. **Added (same class as S129, not in this audit):** S166/S167/S169/S170 "same-Δ stock same $debit" = Δ·ΔS ÷ debit with T-bill on the debit only → stock arm gets ~8–11× free leverage, ≈ +10 bp/$debit/day against calls. No verdict flips alone (S170 also fails cluster t / H2). Logged recurring-bugs B5b + A371. 13 other text-flagged rows not code-checked yet.
3. **Method adopted:** five-case / one-name smoke before any batch. S185 (A390) skew history: 3.5 h batch cancelled; NVDA first via LSE greeks preview (validated ATM vs LSEG iv30 corr 0.90, 1.2 vol pts), then PLTR/HOOD/ONDS, batch only if the pattern survives.
4. **Tool inventory:** no historical skew source beyond LSE greeks export (OptionMetrics sample-only, tastytrade IV rank only) — agreed.
