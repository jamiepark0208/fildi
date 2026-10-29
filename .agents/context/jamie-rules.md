# Jamie's standing rules — every agent (Claude, Cursor, Muse, Codex, Grok)
> One shared copy (10-21: these lived only in Claude's private memory, so other agents got re-taught). Add a rule here the
> first time Jamie states it; never ask him to repeat one. Dates = when he said it.

## Decisions
- **Ask Jamie only about money, accounts, trades.** Bugs, data repairs, remaps, engine merges: decide, fix, verify, report (10-18, 10-21: "why do I have a decision on something as simple as the expiry date").
- **Asking for the task is the approval** — finish end to end incl. promotion; show before/after; don't re-ask (10-18).
- **"Do what's left" = verify and do it now**, don't relist (10-17). Pick the next step from research + tests; never "confirm X?" (10-19).
- Show opportunities with their cost; he decides (10-14).
- **Free cash never filters or flags an opportunity** (repeated; 10-22). He frees cash by selling stock or closing puts. Show the collateral needed as plain info, never as a warn/block/size-down (A243).

- **Fix the producer, never paper over it (10-28):** a blank/0 score, a different strike on another tab, a stale input = find why the
  producer skipped it and make it compute before anything reads it. "Show — instead of 0" is not a fix. Every surface (Model List,
  Rankings, Structures, Live) shows the same contract from the same run. Classes + guards: `.agents/context/recurring-bugs.md`.

## Research and verdicts
- **Opportunity mindset (10-28, the frame for every study and trade idea):** buy low / sell high — buy when fear is high, trim when greed is high.
  By the time news reports bad news, most of it is priced; a crash with everyone bearish is where to *look for* opportunity, a big rally with
  everyone bullish is where to get careful. Treat the consensus view as information, not as the answer. Ideate with a slight optimistic bias,
  then play devil's advocate **to strengthen the idea** (find the risk, then mitigate it), not to reject it. Persist: a study is a loop of
  trial/error — adjust, add or remove factors, change execution (entry, exit, strike, size, hedge), test the **opposite side** (long ↔ short)
  and **combined** long+short structures before calling any idea dead. Low correlation / modest significance is normal in markets; the job is
  to stack controllable factors in our favor, not to be perfect. Keep honesty with a fit set + untouched holdout, not with "one pass, stop".
- Model List rules/tags use **market-wide data only, never Jamie's own trades** (10-20). His trades may be used for diagnostics shown to him.
- Test the **use** (put pnl, breach, sizing), not the direction; a FAIL means tested on the outcome and still failed — then fix it, don't just report it (10-18).
- Compare with a **same-risk alternative** (T-bills, holding the shares) before calling lower risk a benefit; say a small benefit plainly, apart from the significance bar (10-20). "Safe" ≠ "edge".
- Challenge his premise with the studies: "half-right because Sxxx" (10-20).
- FAIL → define the winners, find the pre-entry pattern, confirm on an untouched holdout; "missing data" is not an excuse — fetch or simulate it (10-19, 10-21).
- Smoke-test on ~5 names with hand-checked trades before a full-universe run (10-19).
- Free/local tools first, state the cost; no LLM for numeric decisions (10-15).
- Overlap → head-to-head + marginal gain, not "park" (10-16). A negative test ≠ no use: find what the tool is built for (10-16).
- Every recommendation answers **"so what"**: what changes for his trades, how many bp/$ it is worth, what it costs, do it or not (10-21).

- **Design dynamic, not one pinned answer (10-24):** show the range side by side (e.g. put ladder: every Δ band with kept %, income, worst 5 %, and the tickers that fit each band) so Jamie picks the level; the default/recommended row is highlighted, not the only one shown. Apply to any parameter (delta, DTE, horizon, risk tier) where a single cutoff hides the trade-off.
- **Same inputs, direction flips by strategy (10-24):** every option strategy uses the same inputs; selling options wants the richest options, buying wants the cheapest (a requirement — a gate, not an optional angle); bullish trades want strong names, bearish weak. One home: `scripts/watchlist_sync/strategy_rules.json` (Rankings › Rules) — each input × strategy cell carries want, verdict, where live, study. Test every cell before it ranks; untested cells are the study queue.
- **Benchmark gate (10-28):** any change to how puts are picked (new factor, regime signal, band/strike rule, gate) must run `scripts/watchlist_sync/analysis/put_benchmark.py` (S088 real-fill puts vs the live engine, the Alpaca public baseline and fixed 0.11Δ) and show **BETTER** — holdout 2023→ higher book bp (t ≥ 2) or equal bp with a better worst-5 % week, and not worse before 2023. 'Holdout only' / SAME = don't ship. Add new ideas as variants there.

## Communication
- Caveman: answer first, terse, keep numbers and caveats, no code in chat (10-06, 10-15).
- UI: headline value in the cell, method/source/timestamp in the hover tooltip (10-14, 10-20).
- Name rows by what they do, not just their ID (10-16).
- **No same-hue text on tinted fill** (10-24): never gold/amber text on gold/amber background (e.g. `#d4af37` on `bg-[#d4af37]/15`). Theme/section headers = white (or near-white) text on a clearly different fill (`bg-zinc-800`, solid green/red chips, etc.). Tooltips must say what to *do*, not restate jargon.

## Ops
- Never send merge conflicts to Jamie; sync via `scripts/agent-git-sync.sh` only (10-16).
- Token budget: no forks/parallel agents; one fresh agent per big build, else inline (10-16).
- Probe the vendor and the feeding job before calling a source "down" (10-17).
- Don't make him relay messages between agents (10-05).

- **Indicators (Jamie 10-26):** Jamie uses TradingView indicators for regime, confidence, entry/close timing, context, momentum, RSI, liquidity, S/R and volume. Test an indicator in the role it was built for (timing, exits, re-sell, cross-name pick) — never reject it from a hold-to-expiry filter test; and give it a display/context use even when it has no measured edge. Map + results: `.agents/context/indicators.md`.
