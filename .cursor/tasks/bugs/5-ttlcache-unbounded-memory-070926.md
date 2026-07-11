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
| **Related** | [enh/29](../enhancements/29-redis-optional-shared-cache-070926.md) deferred |
| **Reuse / update** | [`TTLCache`](../artifacts/api-server/src/lib/ttl-cache.ts), [`cache-registry.ts`](../artifacts/api-server/src/lib/cache-registry.ts) admin monitor |

### Purpose
Bound in-memory cache growth; expired entries must not accumulate forever.

---

## 1. Finding + evidence

11 `TTLCache` instances ([`stocks.ts`](../artifacts/api-server/src/routes/stocks.ts) search/quote/history, [`options.ts`](../artifacts/api-server/src/routes/options.ts), etc.). Expiry on `get()` only — keys never read stay in `Map` until TTL passes without access.

[`searchCache`](../artifacts/api-server/src/routes/stocks.ts) 24h TTL × unbounded search strings = worst case.

---

## 2. Repro

1. Run server 48h with varied ticker/search traffic.
2. `GET /api/admin/cache/status` (auth) — watch `search` / `quote` `entryCount` climb monotonically.

---

## 3. Why this bug occurred

- **Genesis:** Single-tenant, small ticker set; unbounded Map acceptable.
- **Drift:** More routes, search queries, multi-user diverse tickers.
- **Category:** unbounded resource

---

## 4. Permanent prevention

- Periodic sweep in `TTLCache` or registry cron (5 min).
- Alert if any cache `entryCount` > threshold in data-health (optional).
- **Non-goals:** Redis (enh/29); FLUSHDB

---

## 5. Fix side-effects

| Risk | Mitigation |
|---|---|
| Evict hot key → thundering herd | LRU cap per cache; keep quote/options higher priority |
| Sweep CPU | Interval 5–10 min; O(n) on small n |

---

## 6. Fix options

**A:** `maxEntries` + LRU eviction on `set`.

**B:** A + background `pruneExpired()` on interval.

---

## 7. Acceptance criteria

- [ ] `entryCount` plateaus under synthetic search load test
- [ ] Admin cache stats still accurate
- [ ] No behavior change for cache hits within TTL

---

## 8. Implementation research pack

| Pri | Path | Change |
|---|---|---|
| **P0** | `lib/ttl-cache.ts` | maxEntries + optional sweep |
| **P1** | `cache-registry.ts` | Expose max in stats |

---

## 9. Verify (before fix)

1. Note current TTLs (e.g. search 24h, quote 1h) — **keep these values after fix**.
2. `GET /api/admin/cache/status` (admin) — record `search.entryCount`, `quote.entryCount`.
3. Read `ttl-cache.ts`: expired entries deleted only on `get()`, not swept.

Optional soak: varied search queries over 48h → `search.entryCount` climbs without bound.

---

## 10. Fix (files)

| Order | Path | Change |
|---|---|---|
| 1 | `artifacts/api-server/src/lib/ttl-cache.ts` | Add `pruneExpired()` + optional `maxEntries` LRU on `set` |
| 2 | `artifacts/api-server/src/lib/cache-registry.ts` | Start interval sweep (5–10 min) OR export prune for scheduler |
| 3 | `artifacts/api-server/src/lib/ttl-cache.test.ts` | **New:** prune removes expired only; cap evicts LRU |

**Do not** reduce `ttlMs` constructor values — user intent is fewer API calls.

---

## 11. Test (after fix)

| Type | Action | Pass |
|---|---|---|
| Unit | 100 `set` + advance time / prune → `entryCount` drops | ✓ |
| Manual | Cache hits within TTL unchanged | ✓ |
| Manual | `admin/cache/status` stats still accurate | ✓ |
| CI | `pnpm --filter @workspace/api-server test` | pass |

---

## 12. Manual-only

- 72h RSS on production instance
- Thundering herd after LRU evict hot key

---

## 13. Regression watchlist

- All 11 `TTLCache` instances keep same TTL durations
- Admin PATCH `/admin/cache/ttl/:name` still works
- `quoteCache` / `searchCache` hit behavior unchanged within TTL

---

## DONE (2026-07-11)

`pruneExpired()` + optional `maxEntries` (LRU eviction on `set`, recency bump on `get`) added to `ttl-cache.ts`. `cache-registry.ts` runs a 10-min `startCacheSweep()` interval calling `pruneExpired()` on all caches, wired into `index.ts` at startup. All TTLs unchanged. `maxEntries` set per-cache by key cardinality: per-ticker caches (quote/breakdown/options/options-expiry/peer-map/peer-profile/ticker-classify/provenance/history-1d) = 1000; combinatorial-key caches (history, compare) = 2000; search already had 2000. Found and fixed a related gap: `profileCache` in `peer-resolver.ts` had a reserved `DISPLAY_NAMES` entry but was never registered or swept — now exported, capped, and wired in. Deduplicated the `ttlCaches` array (was copy-pasted between `startCacheSweep`/`getAllCaches`, which is how `profileCache` got missed) into one shared list. New test file `ttl-cache.test.ts` (4 suites, 8 tests) covers prune + LRU eviction. Full suite: 40/40 pass. Typecheck: no new errors (2 pre-existing failures in `backfill-edgar.ts`/`merge-trusted.ts`, confirmed present on main before this change).
