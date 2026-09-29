# Cursor State
> Cursor-only — do NOT write to `.agents/context/state.md` (Claude Code / shared). Update this file at end of Cursor sessions.

**Last updated:** 2026-09-29

## Phase
**build** — Peer-group auto-classify + quantum cohort + ETF exclusion + winsorized sector percentiles

## READ FIRST
**Peer scoring:** score vs `ticker_registry.primary_peer_group_id` (never watchlist). ETF deny-list SoT: `@workspace/db` `etf-exclusions.ts` (seed + API). Outliers: **2nd/98th winsorize** inside peer groups.
**Canonical plan:** `.cursor/context/plans/fundamental-sector-scoring.md`
**Stock DB plan:** `.cursor/plans/stock-db-best-realistic.md`

## Active work
- Peer groups: seed in `scripts/src/seed-peer-groups.ts` (DB is runtime SoT; Robinhood JSON is historical input)
- New group: `speculative_thematic.quantum_computing` = IONQ, RGTI, QBTS, QUBT, QSI
- Live mis-cat fix: Settings → Peer Group → **Reassign** (`peer_group_overrides` + score recompute). Do not star-toggle.
- `artifacts/config/ticker-mapping-overrides.json` is legacy/empty — do not write auto-classify there

## Next tasks
1. Weekly agent: run skill — summarize value log **including Peers line**
2. When NR ≤250 + §1 green 7d → unify scorers
3. Review `/tmp/fildi-logs/peer-health-last.json` keywordMismatch flags after each weekly run

## Key decisions
- Scoring cohort = all non-ETF tickers sharing `primary_peer_group_id`, winsorized — **not** a curated representative subset
- Vendor peers (Finnhub/FMP) for discovery/auto-classify only; curated peer groups remain scoring SoT
- Admin Reassign is the live correction path for wrong sectors
- Weekly `peer-health-check.ts` heals gaps + classifies new names; mismatches stay human-reviewed

## Do not
- Edit `.agents/context/state.md` from Cursor
- Put ETFs in peer scoring cohorts
- Treat PeerGroupEditor stars as scoring controls (removed)
