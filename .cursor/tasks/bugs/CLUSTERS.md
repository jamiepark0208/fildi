# Bug clusters — read together, implement in order

Use with [INDEX.md](INDEX.md) wave order and [CLAUDE-IMPLEMENT.md](CLAUDE-IMPLEMENT.md).

---

## Cluster A — Watchlist SSOT (multi-user) — DONE 2026-07-10

| # | Slug | Role | Status |
|---|---|---|---|
| 19 | register-empty-watchlist | New users get default rows (**before** testing 2/3) | rejected — product decision, see task DONE note |
| 2 | watchlist-global-constant-split | API: scorecard, indicators, seeder — DB not `WATCHLIST` | done |
| 3 | home-hardcoded-fundamental-universe | FE: `home.tsx` peer-groups from `useWatchlist` | done |
| 10 | watchlist-no-max-size | Server cap; **MAX ≥ 31** (register seed size) | done |
| 13 | react-query-cross-user-bleed | `queryKey` + logout `removeQueries` | done |

**Coupling:** Fix **2** without `indicators.ts` → scanner 404 on user-added tickers.

---

## Cluster B — Fetch overprocessing — DONE 2026-07-11

| # | Slug | Role | Status |
|---|---|---|---|
| 9 | watchlist-peer-flag-cascade | POST watchlist must not bulk-flag peer registry | done |
| 11 | options-scanner-fetch-storm | Replaced with `/api/options/batch` + `optionsCache` | done |
| 12 | watchlist-quote-n-plus-one | Replaced with `/api/stocks/quotes` + `quoteCache` | done |

**Coupling:** **9** shrinks `fetch_fundamentals` registry → affects **4** startup universe size.

---

## Cluster C — Continuous-run health

| # | Slug | Role |
|---|---|---|
| 5 | ttlcache-unbounded-memory | `pruneExpired` + optional cap — **do not shorten TTL** |
| 6 | pg-pool-session-contention | `DATABASE_POOL_MAX` on shared pool |
| 8 | scheduler-restart-drift | Persist `lastEnrichmentRun` in **`app_config`** |
| 18 | session-table-growth | `pruneSessionInterval` on PgSession |

---

## Cluster D — Security

| # | Slug | Role |
|---|---|---|
| 1 | unauthenticated-vendor-routes | Router-level `requireAuth` |
| 7 | rate-limit-single-instance | `trust proxy` when production |
| 17 | admin-routes-auth-not-admin | GET cache/data-health → `requireAdmin` |

---

## Cluster E — Correctness (small)

| # | Slug |
|---|---|
| 15 | catalyst-dual-buildCatalysts |
| 16 | feed-winrate-expired-excluded |

---

## Cluster F — Portfolio (large)

| # | Slug |
|---|---|
| 14 | portfolio-localstorage-not-server |

Coordinate [enh/8](../enhancements/8-portfolio-analysis-improvements-070926.md).
