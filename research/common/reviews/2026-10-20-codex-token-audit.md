# Codex efficiency audit — 2026-10-20

Scope: this chat's local rollout at snapshot time, including the first requests of this audit. No transcript contents exported. Other chats/subagents excluded. Actual per-response token_usage_record records deduplicated by response_id; cumulative thread/turn snapshots ignored. Output includes reasoning where the provider includes it; never add reasoning twice. These counts cannot be converted directly into an Edu-plan percentage or dollar bill.

## Measurement
- Input: 29,609,173; cached input: 28,898,304 (97.6%); uncached input: 710,869.
- Output: 85,672; model requests: 229.
- First measurement before audit expansion: 29,405,936 input; 28,696,960 cached; 708,976 uncached; 83,445 output; 228 requests.
- Largest total-input development segment: Stage/OpenJev repair, 54 requests, 8,487,263 input (8,417,536 cached), 20,060 output. This segment delivered code, tests and live UI verification, but repeated source discovery and late runtime verification added avoidable work.
- Usage-status answer: 8 requests, 1,530,892 input (1,359,616 cached), 620 output; median context 191,747. High overhead for a narrow question. A source refresh plus concise local diagnostic should normally suffice; reuse already-fetched official policy when applicable.
- Tool outputs: shell category 610,521 characters across 140 results; web run 197,620 across 14; UI JS 96,804 across 15 at first measurement. Character volume is NOT measured input-token attribution. Tool instructions/context costs may be separately injected and cannot be causally assigned by this audit.

## What I did inefficiently
Repeated full context/checkpoint reads despite read-once guidance. Long accumulated history carried into small questions. Repeated official-page navigation text instead of targeted sections. Browser inventory included unrelated tabs. Several commands used guessed paths or the wrong package working directory. Hook setup was treated as the likely finish line before actual desktop delivery was established. Independent review found real defects, so removing review would be a false saving; improve the implementation/evidence packet before requesting it.

## Changes applied
1. scripts/codex-token-audit.py: local metadata-only numeric audit; explicit selected rollout, no external calls. Two tests cover dedup/cumulative-snapshot exclusion and privacy. Raw data stored in the adjacent JSON.
2. Condense Codex checkpoint to current state; archive the older checkpoint here rather than appending contradictory history forever.
3. Add a brief evidence-based efficiency rule to CODEX.md: read context once, verify paths/runtime, bound output, reuse passing checks until source changes, and batch independent inspections.
4. Preserve the official ship gate and independent review. Use targeted tests while editing; run package checks after the final relevant edits. Earlier failed gates still require a fix and rerun.

## How to get more development per allowance
One bounded task, one owner, one focused reviewer where needed. Keep broad planning in this chat; a fresh implementation chat can avoid carrying this history, but do not create one automatically without Jamie asking. Use a short checkpoint/task packet for that handoff. Cached context reduces cost but is not free, and starting fresh also loses cache; compare actual outcomes rather than promising a fixed saving.

Use deterministic search/indexes first. OpenJev P11 (tier A) for genuinely long non-sensitive logs, retaining regex and raw evidence; P10 (B) only a shortlist hint; P14 (X) stays keyword search. Do not route tiny outputs through another model or re-evaluate a proven task merely to consume capacity. Do not downgrade Jamie's chosen model without authorization.

Next measurement: audit one completed bounded development task separately. Record requests, uncached/cached input, output, first-pass checks, defects caught, user interventions and useful outcome. Compare like-for-like work; no percentage-savings claim yet. Acceptance: no repeated unchanged context reads, no guessed-path failure, final required checks complete, and no regression/review coverage removed to make tokens look smaller.
