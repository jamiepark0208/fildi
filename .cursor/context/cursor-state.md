# Cursor State
> Cursor-only — do NOT write to `.agents/context/state.md` (Claude Code / shared). Update this file at end of Cursor sessions.

**Last updated:** 2026-06-24

## Phase
**plan → build** — fundamental sector scoring

## READ FIRST
**`.cursor/context/plans/fundamental-sector-scoring.md`**
- Implementation phases + todos
- **APPENDIX I** — current production fundamental & technical scoring (accurate baseline)
- ⛔ Score vs Robinhood `peer_group_members` in DB — **never user watchlist**

Short handoff: `.agents/tasks/2026-06-24-fundamental-sector-scoring.md`

## Active work
- **fundamental-sector-scoring** — planning complete, implementation not started
- Robinhood JSON (external): `/Users/jamiepark/rbh_scripts/fundamental_scoring_guide.json`, `sector_taxonomy.json`

## Next tasks (Cursor priority)
1. **Phase 0** — Drizzle migration (`peer_groups`, `peer_group_members`, registry FK); seed ~558 tickers from JSON; fixture tests
2. **Phase 1** — `scoreFundamental` + pre-computed `fund_score`; unify API rankings; peer-universe SDM refresh
3. **Phase 2** — Wire home.tsx (remove FUNDAMENTAL_WATCHLIST); scanner parity
4. **Phase 3** — forward_pe, ev_ebitda in pipeline

## Key decisions
- Peer universe = Robinhood `all_tickers` (~558), not watchlist, not FUNDAMENTAL_WATCHLIST
- Unmapped ticker → auto-classify + append to mapping overrides (Task 0.5)
- Layer 3 PUT_SELLER must respect sector exclusions (Task 1.5)

## Do not
- Edit `.agents/context/state.md` from Cursor (merge conflicts with Claude Code)
- Commit unrelated WIP (e.g. catalysts.test.ts) with this feature
