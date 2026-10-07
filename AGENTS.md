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
**User 2026-10-07:** Cursor **owns all Muse tasks** (`Muse → Cursor`). Claude must **not** act on Muse ASKS.

Practical rules:
1. **Never make the user relay messages.** ASKS is the log; it never blocks finishing work.
2. **Pull before you assume HEAD is fresh** — `git pull --ff-only origin cursor/mac-dev`.
3. **Muse → Cursor** = Cursor’s queue. **Claude → Claude / Cursor → Claude** = Claude’s (unchanged).
4. **Check before editing:** `git status` / `git diff`; build on others’ work, don’t overwrite.
5. **One home per piece of logic** (`scripts/watchlist_sync/FACTOR_MAP.md`).
6. **Session-state files stay per tool:** Claude → `.agents/context/state.md`, Cursor →
   `.cursor/context/cursor-state.md`. Muse uses ASKS only.
7. Scoring/selection changes need user approval + before/after; bug fixes and display changes don’t.

## Do not load unless the task needs them
`.cursor/tasks/**` · `.claude/docs/phase-report*` · `.cursor/plans/archive/**`
