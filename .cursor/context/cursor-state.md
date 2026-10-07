# Cursor State
> Cursor-only — do NOT write to `.agents/context/state.md` (Claude Code).

**Last updated:** 2026-10-07 (Cursor owns all Muse ASKS)

## Phase
**build** — Muse queue is Cursor-only; Claude must ignore `Muse → *`

## READ FIRST
**Pull:** `git pull --ff-only origin cursor/mac-dev`  
**Muse queue (accepted):** A44 code-integrity · A39 DB quality · A40 wake-safe tasks · A41 optimization audit · A42 API research · A43 live-book UX  
**Standing:** A38 Cursor → Muse monitor (Muse replies with health passes)  
**Adapter:** `MUSE.md` · Claude instructed in `CLAUDE.md` not to take Muse rows

## Active
- Pulled Muse push `732e0e5` (ASKS plans). Retargeted to `Muse → Cursor`; renumbered duplicate A38 → A44.
- Next Muse work: A44 verify 3 bugs STALE on HEAD, then reliability sweep; then A39–A43 in order user prefers.

## Next
1. A44 code-integrity (finish verify + remaining sweep)
2. A40 / A39 (ops) or A43 (UX) — ask user if priority unclear
3. A41 / A42 are research deliverables (no silent behavior changes)

## Do not
- Expect Claude to handle Muse ASKS
- Commit secrets / retune scores without approval
