# TradeDash — Current State

> **Shared** project state — phase and infra reference. Synced by Claude Code `session-wrap.js`.  
> **Cursor task queue:** `.agents/context/cursor-state.md` (do not edit from Cursor wrap).

## Phase
**build** — last updated 2026-06-17

## Active work
- Working: see `.agents/context/cursor-state.md`
- In progress: see `.agents/context/cursor-state.md`
- Blocked: user password was overwritten during Phase 2 testing — current pw is test123, needs reset to original before Phase 5 FILDI

## Next tasks (project-wide)
1. **options-comparison-table** — side-by-side put option comparison UI
2. **strike-explorer-slider** — interactive strike selection slider
3. **user-management-system** — independent watchlists per user (design pending)
4. **macro-data-live-feed** — full FRED polling
5. **reserve-oracle-vm-ip** — OCI reserved IP before VM reboot

## Living task list
`FILDI_ROADMAP.md` (root) — read before starting any new feature.

## Completed (recent — project)
- cursor-state split + Cursor session wrap (2026-06-17)
- macro-ai-highlights, profile-tab-ui (2026-06-17)
- scorecard-guide + watchlist chart zones merged to main (PR #1, 61b6b53)
- options-scanner-enhancement, technical-scorer-v2, fmp-phases-1-5, factset-proxy live

## FactSet Proxy — LIVE ✅ (2026-06-14)
- Oracle Cloud VM `146.235.223.94`
- Env: `FACTSET_PROXY_URL`, `FACTSET_PROXY_SECRET`

## Technical Scorer V2 — COMPLETE
- Known remaining: `scorecard-explanation.tsx` V1 metrics label (partially addressed by Scorecard Guide)

## FMP Data Layer — COMPLETE
- Budget: 220 calls/day via `fmp_api_usage`

## RSI / MFI thresholds
Per-ticker thresholds in `.claude/skills/signal-filters.md`. MFI threshold: 25

## Technicals stale check
```bash
curl -s -X POST http://localhost:8080/api/technicals/refresh?force=true
```
