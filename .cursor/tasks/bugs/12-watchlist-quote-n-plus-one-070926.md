# watchlist-quote-n-plus-one

| Field | Value |
|---|---|
| **Status** | done |
| **Priority** | P1 |
| **Area** | perf / multi-user |
| **Effort** | M |
| **Benefit** | Med |
| **Implementation risk** | Low |
| **Created** | 2026-07-10 |
| **Source** | bugs audit |

## Resolution

Marked done in INDEX.md, but this file itself was never updated with implementation notes (no DONE/Resolution section was left in the original). Planned fix was to replace N parallel per-ticker `/stocks/quote` requests on the watchlist page with a single batched `GET /stocks/quotes?tickers=A,B,C` route (reusing the existing per-ticker `quoteCache` internally) and one `useQuery` on the frontend instead of `useQueries`. Check git history / session logs for the exact commit that closed this out.
