# Event-driven per-ticker refresh

Cadence (7d stale + null + cohort) stays the baseline. **Triggers** only *advance*
a ticker in the queue — they never force full-universe daily pulls.

## v1 shipped — earnings window

| Piece | Role |
|---|---|
| `lib/refresh-triggers.ts` | Window = report_date ∈ [today−1, today+2]; `EARNINGS_STALE_DAYS=1` |
| `nightly-enrichment.ts` | Prioritizes window tickers; uses 1d stale inside window |
| `enrich-earnings-window.ts` | **Daily maintain** bounded refresh (max 40) without waiting for 4d full run |

## Later triggers (not built yet)

| Trigger | Why desks care | Source |
|---|---|---|
| 8-K / material filing | Corporate actions | EDGAR |
| Estimate revision spike | Street underwriting | analyst_events |
| Form 4 cluster | Insider signal | EDGAR / Quantgress |
| 13F / 13D / 13G | Ownership (lagged) | EDGAR |
| Short interest jump | Crowding | FINRA |
| Large move vs SPY | Verify data | OHLCV |

## Design rules
1. Trigger → enqueue with cooldown (earnings uses 1d staging freshness)
2. Respect budgets + SOURCE_ORDER
3. Prefer merge + derives first outside earnings force path
4. Ops entry: `scripts/maintain.mjs --enrich-if-due` (see `.agents/context/INDEX.md`)
