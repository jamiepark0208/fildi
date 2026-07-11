# Bugs backlog

Layout (2026-07-10). Filename = `{seq}-{slug}-070926.md` — **seq = fix priority wave**, not strict dependency order.

| Folder | What goes here |
|---|---|
| [`bugs/`](.) | Production bugs, scale/multi-user defects, perf drift — **fix tasks**, not features |

**Claude start here:** [CLAUDE-IMPLEMENT.md](CLAUDE-IMPLEMENT.md) → matrix below → individual task §9–§13.

Source: production-readiness code audit (plan v2). Each task includes §3 root cause, §4 prevention, §5 fix side-effects, **§9–§13 verify/fix/test**.

This file is now the single status source for bugs/ (a separate CLUSTERS.md used to duplicate the Cluster/Status columns below and drifted out of sync — e.g. bug/13 was `ready` here and `done` there. Deleted; cluster grouping + coupling notes folded in below).

---

## Matrix (summary)

| # | Cluster | P | Status | Effort | Benefit | Impl risk | File |
|---|---|---|---|---|---|---|---|
| 1 | D | P0 | ready | M | Critical | Med | [unauthenticated-vendor-routes](1-unauthenticated-vendor-routes-070926.md) |
| 2 | A | P0 | done | L | Critical | High | [watchlist-global-constant-split](2-watchlist-global-constant-split-070926.md) |
| 3 | A | P1 | done | S | High | Low | [home-hardcoded-fundamental-universe](3-home-hardcoded-fundamental-universe-070926.md) |
| 4 | — | P0 | ready | M | High | Med | [startup-universe-refresh-storm](4-startup-universe-refresh-storm-070926.md) |
| 5 | C | P1 | ready | S | High | Low | [ttlcache-unbounded-memory](5-ttlcache-unbounded-memory-070926.md) |
| 6 | C | P1 | ready | S | Med | Low | [pg-pool-session-contention](6-pg-pool-session-contention-070926.md) |
| 7 | D | P2 | ready | S–L | Med | Low–Med | [rate-limit-single-instance](7-rate-limit-single-instance-070926.md) |
| 8 | C | P1 | ready | M | Med | Med | [scheduler-restart-drift](8-scheduler-restart-drift-070926.md) |
| 9 | B | P1 | done | S | Med | Med | [watchlist-peer-flag-cascade](9-watchlist-peer-flag-cascade-070926.md) |
| 10 | A | P1 | done | XS | Med | Low | [watchlist-no-max-size](10-watchlist-no-max-size-070926.md) |
| 11 | B | P1 | done | M | High | Med | [options-scanner-fetch-storm](11-options-scanner-fetch-storm-070926.md) |
| 12 | B | P1 | done | M | Med | Low | [watchlist-quote-n-plus-one](12-watchlist-quote-n-plus-one-070926.md) |
| 13 | A | P1 | done | XS | Med | Low | [react-query-cross-user-bleed](13-react-query-cross-user-bleed-070926.md) |
| 14 | F | P1 | ready | L | High | High | [portfolio-localstorage-not-server](14-portfolio-localstorage-not-server-070926.md) |
| 15 | E | P2 | ready | S | Med | Low | [catalyst-dual-buildCatalysts](15-catalyst-dual-buildCatalysts-070926.md) |
| 16 | E | P2 | ready | S | Med | Low | [feed-winrate-expired-excluded](16-feed-winrate-expired-excluded-070926.md) |
| 17 | D | P2 | ready | XS | Low | Low | [admin-routes-auth-not-admin](17-admin-routes-auth-not-admin-070926.md) |
| 18 | C | P2 | ready | S | Med | Low | [session-table-growth](18-session-table-growth-070926.md) |
| 19 | A | P1 | rejected | S | High | Low | [register-empty-watchlist](19-register-empty-watchlist-070926.md) |

---

## Clusters — read together, implement in order

- **A — Watchlist SSOT (multi-user)** — 19, 2, 3, 10, 13 — DONE 2026-07-10 except 19 (rejected, product decision — see task DONE note). **Coupling:** fix 2 without `indicators.ts` → scanner 404 on user-added tickers.
- **B — Fetch overprocessing** — 9, 11, 12 — DONE 2026-07-11. **Coupling:** 9 shrinks `fetch_fundamentals` registry → affects 4's startup universe size.
- **C — Continuous-run health** — 5, 6, 8, 18. 5: prune expired RAM only, do not shorten TTL. 8: persist to `app_config`, not `scoring_config`.
- **D — Security** — 1, 7, 17. Do 1 first (auth boundary).
- **E — Correctness (small)** — 15, 16.
- **F — Portfolio (large)** — 14 alone. Coordinate [enh/8](../enhancements/8-portfolio-analysis-improvements-070926.md).

Bug 4 (startup-universe-refresh-storm) isn't part of a lettered cluster but is coupled to cluster B (see above).
