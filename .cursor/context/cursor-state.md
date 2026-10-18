# Cursor State
> Cursor-only — do NOT write to `.agents/context/state.md` (Claude Code).

**Last updated:** 2026-10-18

## Next build
1. A83 Wave 1 finish (date util / zod / yahoo logger) — only with ship-check
2. A126 Phase 1 Schwab/Yahoo 1m VWAP+profile (P2)
3. Skip: A163 (Jamie go), A143 (await 05:30), A83 scorer unify (Jamie)

## Phase
**ops** — A94 boot-fix + ship-check gate live (CI #294 green). No sleep-loops. One row at a time + `agent-ship-check.sh` before every TS push.

## Active
- OpenJev: P14/P16 Cursor-verified; teach loop live; one shared 8091 instance
- Await Claude quant reviews: A82 A93 A114 A146 A149 A96 A113

## Do not
- Ask Jamie whether to commit agent-bus / Ready digs — commit + sync
- Hand `git pull` — only `scripts/agent-git-sync.sh`
- Parallel `oj verify` (registry race) — one at a time
- Auto-promote scorecard weights
