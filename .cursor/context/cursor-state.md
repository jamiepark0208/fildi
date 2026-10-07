# Cursor State
> Cursor-only — do NOT write to `.agents/context/state.md` (Claude Code).

**Last updated:** 2026-10-07 (Muse live via git on `cursor/mac-dev`)

## Phase
**build** — Muse is a live remote teammate (git + ASKS); monitor ask A38 open

## READ FIRST
**Pull first:** `git pull --ff-only origin cursor/mac-dev` (Muse may push while Mac is closed)  
**Cross-tool:** `research/common/ASKS.md` (incl. Muse rows) · adapter: `MUSE.md`  
**Ops:** Nucleus Remediate · `node .cursor/scripts/ops-brief.mjs`

## Active
- `cursor/mac-dev` @ checkpoint with Options live prices, Muse guards, `MUSE.md` protocol.
- **A38** Cursor → Muse: standing monitor for smooth app runs — await Muse’s first health pass on ASKS.
- No Muse commits on remote yet beyond our push (as of last pull).

## Next
1. On each Cursor session: pull mac-dev, read Muse ASKS
2. Act on Muse → Cursor rows when they appear
3. P1 leftovers: technicals/all lite · portfolio quote batch · macro charts split

## Do not
- Commit schwab tokens / secrets
- Auto Duo/OAuth/score weights / ideation merge
- Re-introduce `new YahooFinanceClass()`, local sleep/retry, or cache get+set
- Retune scoring without before/after + user approval
- Freeze Options board price on nightly snapshot (use getLivePrices)
