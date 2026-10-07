# Cursor State
> Cursor-only — do NOT write to `.agents/context/state.md` (Claude Code).

**Last updated:** 2026-10-07 (session wrap — Muse guards + Options live prices + git checkpoint)

## Phase
**build** — Muse reliability fixes on `fix/muse-scheduler-guards`; Options leaderboard live prices + compact Rankings UI

## READ FIRST
**Cross-tool:** `research/common/ASKS.md` · Muse adapter: `MUSE.md`  
**Ops:** Nucleus Remediate · `node .cursor/scripts/ops-brief.mjs`  
**Fair value / fund:** champion path in trader-context / params — scoring changes need approval

## Active
- Branch `fix/muse-scheduler-guards`: fixture guard, crash shutdown+Sentry, regime after-close catch-up; `MUSE.md` added.
- Options scanner: `/api/live/prices` overlay + snap Δ%; compact Rankings Options columns (OS/M badges).
- Large batch also includes Schwab option quotes, portfolio cost carry, research studies, watchlist_sync analysis — committed for Muse HEAD sync.

## Next
1. Push / PR `fix/muse-scheduler-guards` when user wants Muse + CI on remote
2. Merge to `cursor/mac-dev` or `main` after review
3. P1 leftovers: technicals/all lite · portfolio quote batch · macro charts split

## Do not
- Commit schwab tokens / secrets
- Auto Duo/OAuth/score weights / ideation merge
- Re-introduce `new YahooFinanceClass()`, local sleep/retry, or cache get+set
- Retune scoring without before/after + user approval
- Freeze Options board price on nightly snapshot (use getLivePrices)
