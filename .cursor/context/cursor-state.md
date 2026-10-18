# Cursor State
> Cursor-only — do NOT write to `.agents/context/state.md` (Claude Code).

**Last updated:** 2026-10-18

## Next build
1. A98 P2 macro sector flow bars (P1 SSGA ingest done)
2. A126 Phase 1b Polygon 1m backfill
3. Skip: A163 (Jamie go), A133 (Jamie signup), A143 (await 05:30), A83 scorer unify (Jamie)

## Phase
**ops** — Ship-check on every TS push. Shipped 10-18: A83 W1, A126 1a, A98 P1. No sleep-loops.

## Active
- OpenJev: P14/P16 Cursor-verified; teach loop live; one shared 8091 instance
- Await Claude quant reviews: A82 A93 A114 A146 A149 A96 A113

## Do not
- Ask Jamie whether to commit agent-bus / Ready digs — commit + sync
- Hand `git pull` — only `scripts/agent-git-sync.sh`
- Parallel `oj verify` (registry race) — one at a time
- Auto-promote scorecard weights
