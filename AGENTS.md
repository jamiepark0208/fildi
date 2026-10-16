# TradeDash — shared agent ToC
> Single entry for Cursor, Claude Code, and other coding agents. Thin by design — open linked files on demand.

## Read next
1. **[`.agents/context/INDEX.md`](.agents/context/INDEX.md)** — topic → file map  
2. **[`.agents/context/agentic-floors.md`](.agents/context/agentic-floors.md)** — R1–R10 + do-not-build  
3. **[`.agents/AGENTS.md`](.agents/AGENTS.md)** — subagent routing (verifier / data-agent / ui-agent)
4. **[`research/studies/INDEX.md`](research/studies/INDEX.md)** — every study / backtest and its answer. Check it before any analysis; add a row after

## Skills
`.claude/skills/<name>.md` — load **one** at a time (see CLAUDE.md / CURSOR.md tables).

## Tool adapters (do not duplicate policy into these)
| Tool | File |
|---|---|
| Claude Code | [`CLAUDE.md`](CLAUDE.md) |
| Cursor | [`CURSOR.md`](CURSOR.md) + `.cursor/rules/` |
| Muse AI (live remote) | [`MUSE.md`](MUSE.md) — git bus `cursor/mac-dev`; ASKS handoffs **to Cursor only** |

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
8. **Before coding** (A135, Karpathy guidelines): state your assumptions; write the success check first, then loop until it passes.
   Every changed line traces to the request — no drive-by refactors, no speculative options; match the surrounding style.
9. **Reply style = caveman, all agents** (user 2026-10-06, 10-15, 10-16). Answer first line. Terse fragments, drop filler/connectives.
   Keep facts, numbers, caveats, failures. ≤ ~15 bullets, no essays, no tables unless comparing ≥ 3 options. No code in chat.
   Applies to chat, ASKS replies, briefs. Plain words: name a row by what it does, not just its ID.

## Review loop (user decision 2026-10-11)
Muse plans → Claude plan-reviews (**every** Muse row, user 2026-10-14; quant rows get the eval) → Cursor builds → Muse + Claude review the commit independently → Cursor fixes → verified.

**Quant row** = touches scores, what the Model List / trades show, option pricing, backtests, or market-data pipelines.
Non-quant rows still get a Claude plan review (user 2026-10-14: overlap, PM impact, simpler/cheaper path); commit review stays quant-only.

**ASKS format (2026-10-11):** `research/common/ASKS.md` is a one-line index (id link · date · from → to · title · status).
Everything else — spec, replies, status notes, reviews — lives in `research/common/asks/A##.md` (template `asks/_TEMPLATE.md`). Read the index; open a file only to act on it.

1. **Muse files** `Muse → Cursor` (unchanged): new `asks/A##.md` + one index line. Quant rows: title starts with `[quant]`.
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
**Agent trailer (user 2026-10-15):** every commit carries `Agent: claude|cursor|muse` as a trailer → exact attribution in Settings › Agents (commits, queue, tokens).
**Decline check (user 2026-10-15)** — guards against declining a misread ask. Every decline/park states: (1) **Need** — the
underlying want in Jamie's words (from the ask's Context), separate from the proposed method; (2) **Met by / fails because** —
the existing feature, row, or study that covers the need, or the probe/study number showing the need itself doesn't hold;
(3) **Revisit trigger** — the concrete event that reopens it. Decline the method, rarely the need. Muse (or Cursor) may rebut
once with a need Claude missed → Claude re-reviews. When a study a decline cites changes, Claude re-audits that decline.
Claude tracks its last reviewed SHA in `.agents/context/state.md` (`Last reviewed SHA:`) and reviews `git log <sha>..HEAD` at session start.

## Do not load unless the task needs them
`.cursor/tasks/**` · `.claude/docs/phase-report*` · `.cursor/plans/archive/**`
