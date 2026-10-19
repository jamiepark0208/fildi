# TradeDash — shared agent ToC
> Single entry for Cursor, Claude Code, and other coding agents. Thin by design — open linked files on demand.

## Read next
1. **[`.agents/context/INDEX.md`](.agents/context/INDEX.md)** — topic → file map  
2. **[`.agents/context/agentic-floors.md`](.agents/context/agentic-floors.md)** — R1–R10 + do-not-build  
3. **[`.agents/AGENTS.md`](.agents/AGENTS.md)** — subagent routing (verifier / data-agent / ui-agent)
4. **[`research/studies/INDEX.md`](research/studies/INDEX.md)** — every study / backtest and its answer. Check it before any analysis; add a row after. How to run one: [`PLAYBOOK.md`](research/studies/PLAYBOOK.md)

## Skills
`.claude/skills/<name>.md` — load **one** at a time (see CLAUDE.md / CURSOR.md tables).

## Tool adapters (do not duplicate policy into these)
| Tool | File |
|---|---|
| Claude Code | [`CLAUDE.md`](CLAUDE.md) |
| Cursor | [`CURSOR.md`](CURSOR.md) + `.cursor/rules/` |
| Muse AI (live remote) | [`MUSE.md`](MUSE.md) — git bus `cursor/mac-dev`; ASKS handoffs **to Cursor only** |
| Kiro (WIP) | `.kiro/steering/` — pointers to this file only |
| Grok Bot (devil’s advocate) | [`GROK.md`](GROK.md) — review-only skeptic; helps Claude on plans; may edit workflow docs; ASKS `→ Grok` / `Grok → …`. **Skeptic ≠ correct** — evidence still wins. |

## One team (user decision 2026-10-05; Muse via git 2026-10-07)
Claude Code, Cursor, and **Muse** share the repo (subject to scoring-approval rules).

**Muse is a live remote agent** (runs while Mac is closed). Bus = **git** on `cursor/mac-dev` + ASKS.
**User 2026-10-07:** Cursor **owns all Muse tasks** (`Muse → Cursor`). Claude never implements them (it plan-reviews all of them, below).

Practical rules:
1. **Never make the user relay messages.** ASKS is the log; it never blocks finishing work.
2. **Sync with `scripts/agent-git-sync.sh`, never by hand** (user 2026-10-16: merge conflicts never go to Jamie).
   The Mac tree is shared and always dirty: **never** `git stash`, `rebase` (esp. `--autostash`), `pull`, `checkout`/`reset`/`restore`
   of others' files. Commit only your own paths, then run the script: it fetches, replays your commits in a temp worktree
   (mergiraf for code, union for logs, rerere), pushes, and updates only the changed paths here. Exit 2 = real code conflict →
   fix it yourself in the temp worktree way, never hand it to Jamie. New clone: `scripts/agent-git-setup.sh` once.
3. **Muse → Cursor** = Cursor’s queue. **Claude → Claude / Cursor → Claude** = Claude’s (unchanged).
4. **Check before editing:** `git status` / `git diff`; build on others’ work, don’t overwrite.
5. **One home per piece of logic** (`scripts/watchlist_sync/FACTOR_MAP.md`).
6. **Session-state files stay per tool:** Claude → `.agents/context/state.md`, Cursor →
   `.cursor/context/cursor-state.md`. Muse uses ASKS only.
7. Scoring/selection changes need user approval + before/after; bug fixes and display changes don’t.
   **Jamie asking for the task IS the approval** (Jamie 10-18) — do it end to end (incl. promotion), show the before/after, don't re-ask.
8. **Before coding** (A135, Karpathy guidelines): state your assumptions; write the success check first, then loop until it passes.
 Every changed line traces to the request — no drive-by refactors, no speculative options; match the surrounding style.
8b. **Ship gate (Jamie 2026-10-18):** any change under `artifacts/api-server/src/**` or `artifacts/stock-compare/src/**` must pass `scripts/agent-ship-check.sh` (package typecheck) before commit/push. `agent-git-sync.sh` enforces it on push. A94 lesson: a bad import took down the live API + Vite proxies — CI emails are the symptom; boot failure is the product damage. Do not use sleep-loops / subagent fan-out to ship Ready rows.
9. **Reply style = caveman, all agents** (user 2026-10-06, 10-15, 10-16). Answer first line. Terse fragments, drop filler/connectives.
   Keep facts, numbers, caveats, failures. ≤ ~15 bullets, no essays, no tables unless comparing ≥ 3 options. No code in chat.
   Applies to chat, ASKS replies, briefs. Plain words: name a row by what it does, not just its ID.
10. **Web research = `scripts/fetch-page.sh <url> [--deep N] [--save]`** (Crawl4AI, local, $0; A123). Full clean text incl. JS pages;
   built-in web fetch tools summarize/cap pages → use them only for quick lookups. `--save` (→ `research/sources/`) only when a study/ASKS row cites it.
   Muse has Mac file-system access (Jamie 10-16) → runs it itself, same rules.

## Review loop (user decision 2026-10-11; Grok on plans 2026-10-17)
Muse plans → Claude plan-reviews (**every** Muse row, user 2026-10-14; quant rows get the eval) → **Grok may red-team the plan** (subjective / high-bias rows; standing **A141**) → Cursor builds → Muse + Claude review the commit independently → Cursor fixes → verified.
Muse also runs a skeptical verification pass on non-quant plans, **including its own** (user 2026-10-18): skeptical = find ways to improve and fix, not just kill. Must clear the plan quality bar (use cases + expected results + pass/fail verification) or it doesn't ship.
**Reviewer-pushes-phase (user 2026-10-18):** when Muse or Grok reviews **another** agent's non-quant plan (never its own), the review pushes the plan to the next phase. Self-review never advances a plan alone.
**Grok non-quant pilot (user 2026-10-18):** Grok is the primary reviewer for non-quant plans (esp. Muse-authored — diversifies away from self-review). Fix-oriented rubric: every kill carries a specific fix proposal. Claude keeps [quant]; Claude's non-quant review load drops to spot-checks.

**Grok is on the team (Jamie 2026-10-17):** review-only skeptic — helps Claude stress-test plans; may change multi-agent workflow docs (`GROK.md`, ASKS routing, adapter notes). **Not an implementer.** Cursor/Claude treat Grok findings as hypotheses: cite evidence, accept or rebut — **skeptic ≠ correct.** Do not block a build on vibes alone; do not ignore a finding that cites path/study/SHA.

**Quant row** = touches scores, what the Model List / trades show, option pricing, backtests, or market-data pipelines.
Non-quant rows still get a Claude plan review (user 2026-10-14: overlap, PM impact, simpler/cheaper path); commit review stays quant-only.

**ASKS format (2026-10-11):** `research/common/ASKS.md` is a one-line index (id link · date · from → to · title · status).
Everything else — spec, replies, status notes, reviews — lives in `research/common/asks/A##.md` (template `asks/_TEMPLATE.md`). Read the index; open a file only to act on it.

1. **Muse files** `Muse → Cursor` (unchanged): new `asks/A##.md` + one index line. Quant rows: title starts with `[quant]`.
   **Every row (any agent) carries a `Moves:` line** — the scoreboard number it moves (A171) or `ops` (A173, S044: ~40 % of a week moved none). Plan review sends back rows without one.
2. **Claude plan review** (every Muse row, before build; user 2026-10-14): checks overlap with existing code + `research/studies/INDEX.md`,
   adds the eval (test cases / pre-registered study row with stop rule / before-after), appends
   `**Claude plan <date>:** …` to the file's `## Reviews` and sets the index status to `planned`. Claude never implements Muse rows.
   Cursor builds **only** `planned` rows (Claude-reviewed), **one at a time**: the next row starts only after the previous commit's Claude review passes (user 2026-10-15; replaces the 48 h fallback). Order = ASKS priority (P1 data correctness first).
3. **Cursor builds**, commit message carries `Refs: A##` (one trailer per row).
4. **Commit review, independent + parallel:** Muse = bugs/ops/UX; Claude = quant diffs only (look-ahead,
   units, eval run vs the plan's acceptance check). Claude writes its review **before reading Muse's verdict** on that SHA.
   Append `**Muse review <sha>:**` / `**Claude review <sha>:**` to the file's `## Reviews`: `pass` or numbered findings (claim / evidence / fix).
5. **Cursor fixes** findings → status `done`. When both reviews (or Muse only, for non-quant) pass on the fix SHA → `verified` → archive.

Statuses: `open → planned → accepted → done → verified | declined` (say why).
**Agent trailer (user 2026-10-15):** every commit carries `Agent: claude|cursor|muse|grokbot` as a trailer → exact attribution in Settings › Agents (commits, queue, tokens).
**Decline check (user 2026-10-15)** — guards against declining a misread ask. Every decline/park states: (1) **Need** — the
underlying want in Jamie's words (from the ask's Context), separate from the proposed method; (2) **Met by / fails because** —
the existing feature, row, or study that covers the need, or the probe/study number showing the need itself doesn't hold;
(3) **Revisit trigger** — the concrete event that reopens it. Decline the method, rarely the need. Muse (or Cursor) may rebut
once with a need Claude missed → Claude re-reviews. When a study a decline cites changes, Claude re-audits that decline.
Claude tracks its last reviewed SHA in `.agents/context/state.md` (`Last reviewed SHA:`) and reviews `git log <sha>..HEAD` at session start.

## Grok Bot plan review (Jamie 2026-10-17)
Grok Bot is joining as plan reviewer and skeptic at Jamie's direction. Its reviews are advisory until the role is approved via ASKS row A142. Claude stays final on all rows for now. No rule change from this section until Claude plan-reviews A142, Muse comments, and Jamie says yes.

## OpenJev — cheap typed answers for every agent (Jamie 2026-10-17)
Local model on the Mac, $0: it reads long text, you read only a probability → saves your tokens. **Before asking, check the pattern's tier in [`.agents/openjev/REGISTRY.md`](.agents/openjev/REGISTRY.md)** (A proven = may gate work · B hint only · C untested · X never). Call: `scripts/oj.py ask` (exit 3 = unavailable → decide yourself). Never for price forecasts or judging a number you show it.
**Default use points (all agents on the Mac; exit 3 → skip):** before reading > 3 candidate files → `scripts/oj.py files --task "…" [--grep …] [dirs]`; long command/test/build/log → `scripts/oj.py run -- <cmd>`; before any analysis/study → `scripts/oj.py studies "<question>"`; before filing an ASKS row or idea → `scripts/oj.py dupes "<idea>"`; unsure which skill → `scripts/oj.py skill "<task>"`. Results show the pattern tier: below A they are a shortlist to check, not a reason to skip.
**Session start (every agent on the Mac, Jamie 10-18 — no relaying):** `python3 scripts/oj.py pending` → run one listed `verify` (second key; you can't verify your own). Then `oj.py audit` lifecycle notes go to Claude via ASKS. Numbers enter the registry only via `oj.py eval`; tier A needs a second agent's `oj.py verify`. Full rules: [`.agents/openjev/README.md`](.agents/openjev/README.md).

## Do not load unless the task needs them
`.cursor/tasks/**` · `.claude/docs/phase-report*` · `.cursor/plans/archive/**`
