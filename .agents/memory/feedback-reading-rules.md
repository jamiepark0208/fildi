---
name: feedback-reading-rules
description: Codegraph-first rule + file reading discipline to prevent context blowout on session start
metadata:
  type: feedback
---

## Codegraph FIRST — always, before any file read

Use `codegraph_context("<task>")` as the FIRST tool call on any non-trivial task. It returns symbols, callers, and callees in one call without putting raw file content into context. Then use `codegraph_explore` or `codegraph_node` for the specific symbols surfaced. Only fall back to `Read` for details codegraph couldn't surface.

Never open a file just to "understand the shape" — codegraph already has it indexed.

**Why:** Reading 5+ large files on the first prompt consumed ~30% of context before any work was done. Codegraph answers the same structural questions in 3-5 targeted calls that cost a fraction of the tokens.

**How to apply:**
1. `codegraph_context("<task description>")` → identifies relevant symbols
2. `codegraph_explore` or `codegraph_node` on the 1-3 most relevant ones
3. `Read` only for details codegraph missed (specific logic, comments, test cases)
4. Hard limit: max 3 full-file reads per task without user approval
5. Never read options-scanner.tsx, technical-rankings.ts, or technicals-db.ts in full — they are 500-1000 lines each; use codegraph_node for specific functions

## File reading discipline (unchanged)

Never use Explore agents for broad codebase sweeps — they read too many files and burn context.

Before reading any file, state its name and the reason. Use find/grep to locate symbols before reading whole files. If a grep result answers the question, don't open the file.

**Why:** User corrected this after the first plan session consumed excessive tokens via 2 broad Explore agents sweeping 50+ files. Repeated on 2026-06-16: read 7 large files in parallel on first prompt, hit 48% context.

## Exception: tasks with a pre-researched implementation reference pack

If a `.cursor/tasks/**` spec already includes an "Implementation Reference Pack" appendix (exact file paths, line numbers, library usage snippets, route registration diffs — see `10-live-intraday-monitor-071426.md` §Appendix A for the pattern), codegraph calls are largely redundant: the doc already did that lookup. In that case, go straight to targeted `grep -n` + `Read offset+limit` to confirm the referenced line numbers still match, skip `codegraph_context`, and spend the saved calls on live-testing the actual behavior instead (e.g. running new code against real APIs before declaring done).

**Confirmed 2026-07-15:** built live-intraday-monitor Phase 1 (finnhub-ws.ts, candle-aggregator.ts, live-hotlist.ts) this way — grep-verified line refs from the task's Appendix A, skipped codegraph entirely, and it was still a clean, low-token implementation. Still read one full file (`finnhub-client.ts`, 156 lines) past its own READ_GUARD threshold out of habit — grep first even when a file feels short enough to just read.

## Plan Mode makes the same mistake look mandatory — it isn't

**Incident 2026-07-23:** a single `/plan` prompt (ad-hoc re-fetch queue feature) hit 77% context. Root cause: Plan Mode's own Phase 1 instructions say "you should only use the Explore subagent type" for initial understanding, which reads as "skip codegraph, go straight to Explore agents." Two Explore agents were launched with open-ended prompts ("report back with... file paths + line numbers... keep thorough") and each returned a multi-thousand-word report with full pasted code blocks — that raw text lands directly in the main conversation (Explore isn't isolated the way a subagent's internal work is; its *return value* is exactly as large as it wants to make it).

**Why:** CLAUDE.md's codegraph-first mandate ("Use before touching any source file... codegraph tools first... fallback chain") still applies inside Plan Mode. Plan Mode's phase instructions describe *which agent type* to use, not license to skip codegraph_context/codegraph_search first. `codegraph_context("<task>")` would have returned the same symbol/caller/callee map in one cheap call instead of two five-figure-token essays.

**How to apply:**
1. Even in Plan Mode Phase 1, call `codegraph_context`/`codegraph_search` before spawning any Explore agent — only delegate to Explore for what codegraph couldn't surface (e.g. reading actual route-body logic, checking exact conventions in a config file).
2. If an Explore agent is still needed, cap its output explicitly in the prompt: "report under 250-300 words, cite file:line only, do not paste code blocks longer than 5 lines." Open-ended "be thorough" prompts produce open-ended token bills.
3. One Explore agent covering a narrow, specific question beats two broad ones — re-read the "quality over quantity, minimum number necessary" guidance in the Plan Mode tool description; it's easy to skim past when focused on coverage.
