---
name: plan-passes
description: Run before dispatching any plan Claude wrote (ASKS row, study spec, UI spec) — verify → enhance → optimize → UI, one pass at a time, cheap probes only. Findings edit the plan; Grok red-teams quant rows after.
---
# Plan passes (Jamie 11-03)
Why: Claude's own specs went to Cursor unreviewed. A328 had no baseline for long options (caught after 1,050 cells); A329 had no SEC truth definition (3 extra rounds). A bug found in the plan costs about 1/10 of one found after the build.

**Budget:** ≤ 4 tool calls per pass; one batched probe per pass; no full-file reads (grep/head). Output = edits to the plan + one line per finding in its `## Reviews` (`**Claude passes <date>:** V… E… O… U…`). No chat essays.

## 1 Verify (does the plan match reality?)
- Every table/column/script/function the plan names exists (one batched SQL + grep). Date ranges and row counts are stated as they really are.
- Every cited number matches its INDEX row / study file. Dupe check done.
- The acceptance check is runnable (a known answer it must reproduce).

## 2 Enhance (failure checklist: each hit becomes a pass/fail line in the plan)
- Comparator: signal vs any-day base, same period (A328).
- Look-ahead: labels forward-only; features at t; fit/holdout split; holdout once (S082).
- Multiple testing: count distinct results, BH, both halves (A328 P4).
- Units / currency / ADR / sign conventions (A318 BABA, A329 negative equity).
- One producer, no second picker; producer fix, not a reader patch (recurring-bugs).
- Truth definition: what "right" means, which source/tag/period (A329 SEC).
- Stand-in 0 / missing ≠ zero; stale period.
- Runtime (rule 8c): deadlines, caps, cache, poll > TTL, measured before/after.
- Grading: how live results flow back (A327 shadow), and what kills it (stop rule).
- Data coverage claimed vs real: state each source's actual date range + names before promising a feature (A331: real quotes only 2026-10-08→).
- Serving cost: a page/API never loads a study cache per request; precompute aggregates (A331: 7.1 GB baseline pickle).
- Same trade counted twice: identical trades under two labels inflate "distinct" results (S151: month = quarter rows).
- Truth period ≤ 15 months and missing ≠ 0 in any reference/"truth" source (A329 SEC).
Add each new bug class a review catches here (one line, cite the row).

## 3 Optimize
- Reuse existing code/data (name the function). Cheapest data first; $0 vendor where possible.
- Phase it: smallest slice that proves value first, stop rule per phase.
- Cut scope that doesn't move a scoreboard number (`Moves:`).
- Token cost: packets ≤ 20 lines, Cursor does the heavy runs.

## 4 UI (any plan with a screen)
- **Answer first:** the top line answers Jamie's question in ≤ 1 sentence with the number + verdict (e.g. "Beats base: breach 0.9 % vs 11.1 %, +0.6 %/trade, PASS sell bar").
- **Implication next:** what to do with it (trade / don't / watch), in plain words.
- **Then detail on demand:** tabs/expanders/hover; never everything at once. Max ~5 numbers above the fold.
- Compare by default (signal vs base side by side, same scale). Colour only for meaning (pass/fail, better/worse).
- Defaults are the answer to the common question: preset loaded, sensible dates. One click to run.
- Every number has its "vs what" and n. Tooltips hold method/caveats (memory ui-tooltips-concise).
- Screenshot check (Playwright) in acceptance: can the answer be read in 5 seconds?

## Learn (every plan)
- Write the plan with this checklist open, so the passes should find little. Each pass finding and each later escape (a bug the build or review found that the passes missed) gets a line in `.agents/context/plan-passes-log.md`: date · row · found-by (pass / review / build) · class.
- Monthly: escapes per plan should fall. A class that escapes twice → add or sharpen a checklist line. A line that never fires in 2 months → cut it (keeps the skill short).

## Then
Quant rows → Grok red-team (own review never advances own plan). Non-quant → dispatch.
