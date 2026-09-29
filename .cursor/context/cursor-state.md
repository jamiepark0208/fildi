# Cursor State
> Cursor-only — do NOT write to `.agents/context/state.md` (Claude Code). Update at end of Cursor sessions.

**Last updated:** 2026-09-29

## Phase
**build** — shared context Phase A+B landed; maintain + peer scoring continue

## READ FIRST
**Shared map:** `.agents/context/INDEX.md` (+ root `AGENTS.md`)  
**Peer scoring:** `primary_peer_group_id` + winsorize; ETF deny-list `@workspace/db`  
**Sector plan:** `.agents/context/plans/fundamental-sector-scoring.md`  
**Stock DB:** `.agents/context/stock-db-best-realistic.md`

## Active work
- Shared ops SoT under `.agents/context/` (Cursor + Claude); private phase in this file
- Daily maintain: bounded enrich + drain + peer-health + scores-only; full nightly only if ≥4d
- Peers: quantum group; Reassign for mis-cats; `FUNDAMENTAL_WATCHLIST` gone

## Next tasks
1. Weekly data-ops skill + value log (Peers line)
2. When NR ≤250 + §1 green 7d → unify scorers
3. Review `maintain-last.json` / `peer-health-last.json` after runs
4. Always-on Mac if 10:30 often missed
5. knip on `test-*.ts` one-offs (confirm before delete)

## Do not
- Edit `.agents/context/state.md` from Cursor
- Put ETFs in peer scoring cohorts
- Stop after CreatePlan when user said implement/proceed — execute
