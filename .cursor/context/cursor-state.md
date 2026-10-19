# Cursor State
> Cursor-only — do NOT write to `.agents/context/state.md` (Claude Code).

**Last updated:** 2026-10-18 (evening)

## Next build
1. A83 Wave 2 leftovers (fund-score normalize extract; scorer unify = Jamie)
2. A85 ingest pipes / A86 reverse-DCF-on-street / A125 upload
3. A96 overnight breadth `--days=500` (MA% capped)
4. Skip: A163 (Jamie go), A133 (Jamie signup), study-first A79/A101/A115

## Phase
**ops** — Ready continue inline (no “next?”, no orchestrator). Ship-check every TS push.

## Shipped this session (sample)
- A83: ohlcv-freshness, indicator-compute, model-track-grade
- A87 Maintain noBar5d; A127 AnimatedNumber accents done
- A96 Regime breadth backfill+MA defer; A98 closed (iShares WAF)
- A85 Voices P1 + seed; A86 street_pt + chart + gaps panel
- A139 ICT toggle; A125 Video Lab P1

## Do not
- Ask Jamie whether to commit agent-bus / Ready digs — commit + sync
- Hand `git pull` — only `scripts/agent-git-sync.sh`
- Parallel `oj verify` (registry race) — one at a time
- Auto-promote scorecard weights
- Orchestrator / subagent fan-out for Ready queue

## Session 2026-10-18 cont
Shipped: A83 normalizeCohort; A86 street reverse-DCF + vsSt column; A85 Fed RSS ingest; A125 upload + Ollama hooks. Next buildable: A125 reel inbox, A83 more splits, A139 study, A96 breadth overnight.

## Cont 2026-10-18 evening
Shipped inline: A83 (normalize, tilt, metrics, raw, model-track-bars); A86 (street reverse-DCF + vsSt); A85 Fed RSS; A125 upload+Ollama+reel inbox.
Still open buildable: A83 more god-file; A85 Brier; A125 Whisper; A139 S036 study-first; skip A133/A163 Jamie.
- Also: A85 Brier, A139 BOS/S&D+fire-count, A95 Book filter, more A83 splits.
