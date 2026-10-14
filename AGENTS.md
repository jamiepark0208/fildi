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
2. **Pull before you assume HEAD is fresh** — `git pull --ff-only origin cursor/mac-dev`.
3. **Muse → Cursor** = Cursor’s queue. **Claude → Claude / Cursor → Claude** = Claude’s (unchanged).
4. **Check before editing:** `git status` / `git diff`; build on others’ work, don’t overwrite.
5. **One home per piece of logic** (`scripts/watchlist_sync/FACTOR_MAP.md`).
6. **Session-state files stay per tool:** Claude → `.agents/context/state.md`, Cursor →
   `.cursor/context/cursor-state.md`. Muse uses ASKS only.
7. Scoring/selection changes need user approval + before/after; bug fixes and display changes don’t.

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
   Cursor builds from `planned`; if Claude hasn't reviewed in 48 h, Cursor may build and Claude reviews the commit.
3. **Cursor builds**, commit message carries `Refs: A##` (one trailer per row).
4. **Commit review, independent + parallel:** Muse = bugs/ops/UX; Claude = quant diffs only (look-ahead,
   units, eval run vs the plan's acceptance check). Claude writes its review **before reading Muse's verdict** on that SHA.
   Append `**Muse review <sha>:**` / `**Claude review <sha>:**` to the file's `## Reviews`: `pass` or numbered findings (claim / evidence / fix).
5. **Cursor fixes** findings → status `done`. When both reviews (or Muse only, for non-quant) pass on the fix SHA → `verified` → archive.

Statuses: `open → planned → accepted → done → verified | declined` (say why).
Claude tracks its last reviewed SHA in `.agents/context/state.md` (`Last reviewed SHA:`) and reviews `git log <sha>..HEAD` at session start.

## Do not load unless the task needs them
`.cursor/tasks/**` · `.claude/docs/phase-report*` · `.cursor/plans/archive/**`
