# Fundamental Sector-Relative Scoring — Handoff
**STATUS:** planning complete, implementation not started  
**Date:** 2026-06-24  
**Resume:** Read **APPENDIX I** in the canonical plan first (current production scoring), then implementation phases.

## Docs (single source of truth)
- **`.cursor/context/plans/fundamental-sector-scoring.md`** — full plan + APPENDIX I (current fundamental/technical methodology)
- **`.cursor/context/cursor-state.md`** — phase, next tasks (injected on new chat)
- Robinhood JSON (external): `/Users/jamiepark/rbh_scripts/fundamental_scoring_guide.json`, `sector_taxonomy.json`

## Goal
Cross-sector comparable **fundamental scores** for CSP/wheel strategy. Each ticker scored vs **fixed Robinhood peer universe in DB** (~558 tickers seeded) — never vs user's watchlist.

## ⛔ NOT watchlist scoring
- User with **1 ticker** → score vs that ticker's `peer_group_members` (e.g. NVDA vs semis panel from seed)
- **`FUNDAMENTAL_WATCHLIST` in home.tsx** = legacy UI hack — **remove on ship**, not a peer pool
- Robinhood `all_tickers` per group = the comparison universe (ignore `your_tickers` in JSON)

## User decisions (authoritative)
- Pre-seed all ~558 taxonomy tickers with `primary_peer_group_id`
- Hardcoded peer mappings in DB — seed once, weekly refresh, score reads DB only
- Dual membership → `primary_peer_group_id` (NVDA → semis)
- Pre-compute `fund_score` for multi-user scale; unify duplicate scorers

## Production gaps
- `__global__` in `computeRankingsV2`
- Duplicate scorers (home V2 vs API rankings vs dead peer-rankings)
- Peer infra unused for scoring

## Key code paths
- `rankings.ts`, `rankings-helpers.ts`, `home.tsx` (remove FUNDAMENTAL_WATCHLIST)
- `fundamentals.ts`, `stock-data-manager.ts`
- `lib/db/src/schema/index.ts`

## Not started
No implementation code yet.
