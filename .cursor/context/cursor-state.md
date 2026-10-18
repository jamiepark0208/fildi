# Cursor State
> Cursor-only — do NOT write to `.agents/context/state.md` (Claude Code).

**Last updated:** 2026-10-18

## Next build
1. A83 Wave 2 (non-scorer) or next planned Cursor P1
2. A126 overnight: `intraday_1m_backfill.py` full universe (~42 tickers / ~84 calls)
3. Skip: A163 (Jamie go), A133 (Jamie signup), A143 (await 05:30), A83 scorer unify (Jamie)

## Phase
**ops** — Ship-check on every TS push. Shipped 10-18: A83 W1, A126 1a+1b pipeline, A98 P1+P2. No sleep-loops.

## Active
- OpenJev: P14/P16 Cursor-verified; teach loop live; one shared 8091 instance
- Await Claude quant reviews: A82 A93 A114 A146 A149 A96 A113

## Do not
- Ask Jamie whether to commit agent-bus / Ready digs — commit + sync
- Hand `git pull` — only `scripts/agent-git-sync.sh`
- Parallel `oj verify` (registry race) — one at a time
- Auto-promote scorecard weights
