# Bugs backlog

Layout (2026-07-10). Filename = `{seq}-{slug}-070926.md` — **seq = fix priority wave**, not strict dependency order.

| Folder | What goes here |
|---|---|
| [`bugs/`](.) | Production bugs, scale/multi-user defects, perf drift — **fix tasks**, not features |

**Claude start here:** [CLAUDE-IMPLEMENT.md](CLAUDE-IMPLEMENT.md) → [CLUSTERS.md](CLUSTERS.md) → individual task §9–§13.

Source: production-readiness code audit (plan v2). Each task includes §3 root cause, §4 prevention, §5 fix side-effects, **§9–§13 verify/fix/test**.

---

## Matrix (summary)

| # | P | Status | Effort | Benefit | Impl risk | File |
|---|---|---|---|---|---|---|
| 1 | P0 | ready | M | Critical | Med | [unauthenticated-vendor-routes](1-unauthenticated-vendor-routes-070926.md) |
| 2 | P0 | ready | L | Critical | High | [watchlist-global-constant-split](2-watchlist-global-constant-split-070926.md) |
| 3 | P1 | ready | S | High | Low | [home-hardcoded-fundamental-universe](3-home-hardcoded-fundamental-universe-070926.md) |
| 4 | P0 | ready | M | High | Med | [startup-universe-refresh-storm](4-startup-universe-refresh-storm-070926.md) |
| 5 | P1 | ready | S | High | Low | [ttlcache-unbounded-memory](5-ttlcache-unbounded-memory-070926.md) |
| 6 | P1 | ready | S | Med | Low | [pg-pool-session-contention](6-pg-pool-session-contention-070926.md) |
| 7 | P2 | ready | S–L | Med | Low–Med | [rate-limit-single-instance](7-rate-limit-single-instance-070926.md) |
| 8 | P1 | ready | M | Med | Med | [scheduler-restart-drift](8-scheduler-restart-drift-070926.md) |
| 9 | P1 | done | S | Med | Med | [watchlist-peer-flag-cascade](9-watchlist-peer-flag-cascade-070926.md) |
| 10 | P1 | ready | XS | Med | Low | [watchlist-no-max-size](10-watchlist-no-max-size-070926.md) |
| 11 | P1 | done | M | High | Med | [options-scanner-fetch-storm](11-options-scanner-fetch-storm-070926.md) |
| 12 | P1 | done | M | Med | Low | [watchlist-quote-n-plus-one](12-watchlist-quote-n-plus-one-070926.md) |
| 13 | P1 | ready | XS | Med | Low | [react-query-cross-user-bleed](13-react-query-cross-user-bleed-070926.md) |
| 14 | P1 | ready | L | High | High | [portfolio-localstorage-not-server](14-portfolio-localstorage-not-server-070926.md) |
| 15 | P2 | ready | S | Med | Low | [catalyst-dual-buildCatalysts](15-catalyst-dual-buildCatalysts-070926.md) |
| 16 | P2 | ready | S | Med | Low | [feed-winrate-expired-excluded](16-feed-winrate-expired-excluded-070926.md) |
| 17 | P2 | ready | XS | Low | Low | [admin-routes-auth-not-admin](17-admin-routes-auth-not-admin-070926.md) |
| 18 | P2 | ready | S | Med | Low | [session-table-growth](18-session-table-growth-070926.md) |
| 19 | P1 | ready | S | High | Low | [register-empty-watchlist](19-register-empty-watchlist-070926.md) |

**Themes:** security · multi-user · continuous-run · overprocessing · data-drift

**Wave order:** 1+4+19 → 2+3+13 → 5–12 → 9+14 → 15–18+7

**Deps:** 1 before confident prod; 2 before 3/11/16; 4 independent; 19 before 2 UX testing; 14 ↔ [enh/8](../enhancements/8-portfolio-analysis-improvements-070926.md); 15 ↔ L-05 + [enh/4](../enhancements/4-api-integration-test-harness-070926.md); 16 ↔ [enh/13](../enhancements/13-feed-improvements-070926.md); prevention gates ↔ [enh/3](../enhancements/3-ci-pipeline-typecheck-tests-070926.md) + [enh/4](../enhancements/4-api-integration-test-harness-070926.md)

**Follow-on (not filed yet):** 72h soak test, k6 multi-user, Playwright 2-user logout — after Wave 1 fixes.

---

## Skills & CI

| Need | Link |
|---|---|
| Implement guide | [CLAUDE-IMPLEMENT.md](CLAUDE-IMPLEMENT.md) |
| Cluster map | [CLUSTERS.md](CLUSTERS.md) |
| Caching / TTL | `.claude/skills/caching-patterns.md` |
| Data / FMP budget | `.claude/skills/data-architecture.md` |
| CI tests | [enh/3](../enhancements/3-ci-pipeline-typecheck-tests-070926.md) |
| API test harness | [enh/4](../enhancements/4-api-integration-test-harness-070926.md) |
