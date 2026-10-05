# Cursor State
> Cursor-only — do NOT write to `.agents/context/state.md` (Claude Code).

**Last updated:** 2026-10-04 (efficiency P0s done)

## Phase
**build** — efficiency playbook P0 shipped (AI limiter + watchlist snapshot Options)

## READ FIRST
**Efficiency:** `.agents/context/efficiency-playbook.md`  
**Schwab:** `.agents/context/schwab-market-data.md`  
**Desk:** `.agents/context/desk-commentaries.md`

## Active
- Shared `callHaiku` + `aiLimiter` on explain / daily-brief refresh / desk daily-news / macro generate
- `ai_usage_log` has `input_tokens` / `output_tokens` (migrate-0029 applied)
- Watchlist Options: rankings ∩ watchlist; chains on expand only (no batch on load)
- Shared `queryKeys.technicalsAll` / `optionsBatch` across Rankings/Live/Options/Tech

## Next
1. P1: `technicals/all` lite projection / field split
2. Portfolio position-quote batch + short TTL
3. Macro charts cache split (regime vs liquidity)

## Do not
- Commit schwab tokens / secrets
- Feed desk news into fund_score
- Re-enable watchlist `/options/batch` on page load
