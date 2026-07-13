# ttlcache-unbounded-memory

| Field | Value |
|---|---|
| **Status** | done — 2026-07-11 |
| **Priority** | P1 |
| **Area** | continuous-run / perf |
| **Effort** | S |
| **Benefit** | High — stable RSS over 72h+ uptime |
| **Implementation risk** | Low |
| **Created** | 2026-07-10 |
| **Source** | bugs audit |

## Resolution

Added `pruneExpired()` plus optional `maxEntries` (LRU eviction on `set`, recency bump on `get`) to `ttl-cache.ts`. `cache-registry.ts` now runs a 10-minute `startCacheSweep()` interval calling `pruneExpired()` across all caches, wired in at startup in `index.ts`. All existing TTL durations were left unchanged; `maxEntries` was set per-cache by key cardinality (1000 for per-ticker caches, 2000 for combinatorial-key caches).

While implementing, found and fixed a related gap: `profileCache` in `peer-resolver.ts` was never registered or swept due to the `ttlCaches` array being duplicated (copy-pasted) between two functions — deduplicated into one shared list so nothing gets missed again. New `ttl-cache.test.ts` covers prune and LRU eviction (8 tests). Full suite (40/40) and typecheck pass clean.
