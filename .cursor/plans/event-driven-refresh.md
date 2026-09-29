# Event-driven per-ticker refresh

Cadence (7d stale + null + cohort) stays the baseline. **Triggers** only *advance*
a ticker in the queue — they never force full-universe daily pulls.

## v1 shipped — earnings window

`lib/refresh-triggers.ts` + nightly enrichment:
- Tickers with `earnings_calendar.report_date` in **[today−1, today+2]**
- Prioritized to front of every source queue
- Yahoo / Finnhub / FMP use **1-day** stale (vs 7d) so post-print numbers refresh once
- Still respects daily API budgets

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
