# Jamie's standing rules — every agent (Claude, Cursor, Muse, Codex, Grok)
> One shared copy (10-21: these lived only in Claude's private memory, so other agents got re-taught). Add a rule here the
> first time Jamie states it; never ask him to repeat one. Dates = when he said it.

## Decisions
- **Ask Jamie only about money, accounts, trades.** Bugs, data repairs, remaps, engine merges: decide, fix, verify, report (10-18, 10-21: "why do I have a decision on something as simple as the expiry date").
- **Asking for the task is the approval** — finish end to end incl. promotion; show before/after; don't re-ask (10-18).
- **Score changes are the agent's call (Jamie 11-06):** "a score change doesn't need my approval, it needs you to check if the logic makes better sense and for you to decide." Check the logic + measured before/after (holdout, vs the live score, vs T-bill), then decide and ship; report the decision and numbers, never ask.
- **"Do what's left" = verify and do it now**, don't relist (10-17). Pick the next step from research + tests; never "confirm X?" (10-19).
- Show opportunities with their cost; he decides (10-14).
- **Free cash never filters or flags an opportunity** (repeated; 10-22). He frees cash by selling stock or closing puts. Show the collateral needed as plain info, never as a warn/block/size-down (A243).

- **Fix the producer, never paper over it (10-28):** a blank/0 score, a different strike on another tab, a stale input = find why the
  producer skipped it and make it compute before anything reads it. "Show — instead of 0" is not a fix. Every surface (Model List,
  Rankings, Structures, Live) shows the same contract from the same run. Classes + guards: `.agents/context/recurring-bugs.md`.

## Research and verdicts
- **Max the data before "can't" (11-17, Jamie: "you always come to me saying its not possible, and then it turns out you didn't even try"):** before any "can't answer / underpowered / not enough data / not possible", rebuild the test on the longest panel we own (LSEG daily_history, CRSP, cboe_daily, LSE 1m, Polygon — see research/common/data-inventory.md) or fetch what's missing yourself. A pre-built table (study_trades, one study's output) is never the limit. The verdict names what was tried: `Data checked: <sources · span · n>` — scripts/verdict-check.sh blocks the push without it. Then say what limits it (episode count, not rows) and fix it in the same session.
- **Enhance = rank + explain, never hide (11-17):** a study result changes the ORDER and the WHY/caution shown on an idea, not whether Jamie sees it. Only safety blocks hide (earnings across expiry, stale chain, no tradable strike, one sale per name-week). "Did you find anything helpful?" → lead with what works and how it's now used in the UI; a no-lift result is a ranking input, not a reason to drop a strategy.
- **Opportunity mindset (10-28, the frame for every study and trade idea):** buy low / sell high — buy when fear is high, trim when greed is high.
  By the time news reports bad news, most of it is priced; a crash with everyone bearish is where to *look for* opportunity, a big rally with
  everyone bullish is where to get careful. Treat the consensus view as information, not as the answer. Ideate with a slight optimistic bias,
  then play devil's advocate **to strengthen the idea** (find the risk, then mitigate it), not to reject it. Persist: a study is a loop of
  trial/error — adjust, add or remove factors, change execution (entry, exit, strike, size, hedge), test the **opposite side** (long ↔ short)
  and **combined** long+short structures before calling any idea dead. Low correlation / modest significance is normal in markets; the job is
  to stack controllable factors in our favor, not to be perfect. Keep honesty with a fit set + untouched holdout, not with "one pass, stop".
- Model List rules/tags use **market-wide data only, never Jamie's own trades** (10-20). His trades may be used for diagnostics shown to him.
- Test the **use** (put pnl, breach, sizing), not the direction; a FAIL means tested on the outcome and still failed — then fix it, don't just report it (10-18).
- Compare with a **same-risk alternative** (T-bills, holding the shares) before calling lower risk a benefit (study contract §2); say a small benefit plainly, apart from the significance bar (10-20). "Safe" ≠ "edge".
- Challenge his premise with the studies: "half-right because Sxxx" (10-20).
- FAIL → define the winners, find the pre-entry pattern, confirm on an untouched holdout; "missing data" is not an excuse — fetch or simulate it (10-19, 10-21).
- Smoke-test on ~5 names with hand-checked trades before a full-universe run (10-19).
- Free/local tools first, state the cost; no LLM for numeric decisions (10-15).
- Overlap → head-to-head + marginal gain, not "park" (10-16). A negative test ≠ no use: find what the tool is built for (10-16).
- Every recommendation answers **"so what"**: what changes for his trades, how many bp/$ it is worth, what it costs, do it or not (10-21).

- **Design dynamic, not one pinned answer (10-24):** show the range side by side (e.g. put ladder: every Δ band with kept %, income, worst 5 %, and the tickers that fit each band) so Jamie picks the level; the default/recommended row is highlighted, not the only one shown. Apply to any parameter (delta, DTE, horizon, risk tier) where a single cutoff hides the trade-off.
- **Same inputs, direction flips by strategy (10-24):** every option strategy uses the same inputs; selling options wants the richest options, buying wants the cheapest (a requirement — a gate, not an optional angle); bullish trades want strong names, bearish weak. One home: `scripts/watchlist_sync/strategy_rules.json` (Rankings › Rules) — each input × strategy cell carries want, verdict, where live, study. Test every cell before it ranks; untested cells are the study queue.
- **Conditional backtests (11-06):** a strategy executes only when its entry condition (regime/indicator match) is met — never on a fixed interval. Every backtest reports hits (n, N_eff), a close condition, take-profit and stop-loss thresholds, exit-reason mix, and lift vs the every-day base rate. Strikes = nearest listed to the target delta, never silently rounded conservative. Spec: A359.
- **Measure what shipped (11-10):** every agent: before claiming a feature, rec or study helped, show `scripts/rec_scoreboard.py` — did it change one of Jamie's trades (same contract), and did recs beat Jamie's own trades in the same window. Recs are regime-conditional: a skew/vol/structure rule is tested inside each regime with a pre-registered sign per cell, never as one sign across regimes, never split by calendar half. Under 30 trades per cell = not run, not reported as a finding.
- **Entry candle (11-10):** Jamie skips the first 30–60 min (outsized open moves), sells puts near the intraday low and calls near the intraday high, then profits from mean reversion + theta. Every premium-selling backtest/rec picks its entry minute by a real-time rule (after the open window, near the running low/high — no full-day hindsight) and prices the option at that minute. Daily closes or 'whenever the job ran' are not valid entries. Regime: Jamie calls Oct 2026 a bearish trend (H1 bull); label regime by trend, not by a lagging 20-day window.
- **Probabilistic, researched (11-10):** trading is probabilities, not if-then. Before building a trading rule, read the published research on the mechanism; combine Fildi's indicators into a calibrated P(outcome) + expected P&L + tail + size. Report nothing as a finding unless it moved the scoreboard; say 'nothing found' first. Study rules 12–14 in `.agents/dispatch/_study-contract.md` apply to inline studies too.
- **Benchmark gate (10-28):** any change to how puts are picked (new factor, regime signal, band/strike rule, gate) must run `scripts/watchlist_sync/analysis/put_benchmark.py` (S088 real-fill puts vs the live engine, the Alpaca public baseline and fixed 0.11Δ) and show **BETTER** — holdout 2023→ higher book bp (t ≥ 2) or equal bp with a better worst-5 % week, and not worse before 2023. 'Holdout only' / SAME = don't ship. Add new ideas as variants there.

## Communication
- Caveman: answer first, terse, keep numbers and caveats, no code in chat (10-06, 10-15).
- UI: headline value in the cell, method/source/timestamp in the hover tooltip (10-14, 10-20).
- **Shape messy prompts before acting (Jamie 11-16):** "I often prompt babble because I am unorganized with thoughts." When a prompt is long, mixes several asks or is unclear, first restate it in ≤ 5 lines: **Goal** (this task, under the app goal = better trading decisions through the Fildi UI) · **Done when** (how success is checked) · **Constraints** (scope, token/time budget, others' files not to touch) · **Params** (tickers, dates, thresholds). Then execute it. Skip for short clear prompts. No wandering: work outside the restated goal needs a stated reason.
- **UI order = importance (Jamie 11-16):** tabs, sections, columns and cards are ordered by how much they change a trade decision — first tab is most important, then the next. Text is short, plain English, straight to the point; jargon only with a tooltip. Place by importance, not by build date. When you see a surface that breaks this (e.g. Breakdown tabs), fix it or file it to the file's owner.
- Name rows by what they do, not just their ID (10-16).
- **No same-hue text on tinted fill** (10-24): never gold/amber text on gold/amber background (e.g. `#d4af37` on `bg-[#d4af37]/15`). Theme/section headers = white (or near-white) text on a clearly different fill (`bg-zinc-800`, solid green/red chips, etc.). Tooltips must say what to *do*, not restate jargon.

## Ops
- Never send merge conflicts to Jamie; sync via `scripts/agent-git-sync.sh` only (10-16).
- Token budget: no forks/parallel agents; one fresh agent per big build, else inline (10-16).
- Probe the vendor and the feeding job before calling a source "down" (10-17).
- Don't make him relay messages between agents (10-05).

- **Indicators (Jamie 10-26):** Jamie uses TradingView indicators for regime, confidence, entry/close timing, context, momentum, RSI, liquidity, S/R and volume. Test an indicator in the role it was built for (timing, exits, re-sell, cross-name pick) — never reject it from a hold-to-expiry filter test; and give it a display/context use even when it has no measured edge. Map + results: `.agents/context/indicators.md`.
- **Indicators are context, not pass/fail (Jamie 10-29):** "I never asked for indicators to lead to long-term gains — find patterns for the lows and highs of a period; nobody said they were perfect." Test with `.agents/skills/fildi-pattern-research` (forward turning-point label, lift tiers strong/useful/weak, confluence + one combined model, then trade translation). Never gate an indicator on "adds over the risk score at |t| ≥ 2 both halves"; report the lift.
- **Check the whole population, then say what you found (Jamie 10-30):** any parser / ETL / unit / scoring change is re-run on every row it touches (not a hand-picked handful) with invariants and a cross-source match rate, before it is called done. Report the bugs found in your own work unasked — "did you check for bugs?" must never be the question that finds them (B18). Automated checks must be cheap and run only when needed, with the trigger written down: full population when the code that produces the rows changed (hash), else only the rows this run added (Jamie 10-30: optimisation is part of the workflow; earnings audit = 3.6 s full / 18 ms new / 0 ms skip).
- **Build on what exists — one engine per job (Jamie 10-30):** before adding a module, search for every place that already does the job (codegraph, git grep the table/vendor, FACTOR_MAP, the duplicate-layer audit) and extend it; a plan or commit without an `Existing:` line is not ready. Two layers doing one job = a bug to merge (B19).

