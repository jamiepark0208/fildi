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
| Muse AI (bug-find / verify) | [`MUSE.md`](MUSE.md) — verify vs HEAD; hand off via ASKS |

## One team (user decision 2026-10-05)
There are no lanes. Claude Code and Cursor can both change any code, data or doc in this repo. Older docs and ASKS rows that say
"Cursor's lane" / "Claude's lane" are history, not rules. What remains are practical rules:
1. **Never make the user relay messages** between tools. `research/common/ASKS.md` is a log the other tool reads on its next run;
   it never blocks finishing work, and reviews are optional.
2. **Check before editing:** `git status` / `git diff` the file first. If the other tool has uncommitted work in it, build on it, don't overwrite it.
3. **One home per piece of logic** (`scripts/watchlist_sync/FACTOR_MAP.md`): extend the existing implementation instead of writing a second one.
4. **Session-state files stay per tool** (merge conflicts only): Claude writes `.agents/context/state.md`, Cursor writes `.cursor/context/cursor-state.md`.
5. Changes to how ideas are scored or chosen still need the user's approval with a before/after; bug fixes and display changes don't.

## Do not load unless the task needs them
`.cursor/tasks/**` · `.claude/docs/phase-report*` · `.cursor/plans/archive/**`
