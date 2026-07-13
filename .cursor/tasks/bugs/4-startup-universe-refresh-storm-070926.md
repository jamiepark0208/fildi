# startup-universe-refresh-storm

| Field | Value |
|---|---|
| **Status** | done — 2026-07-10 |
| **Priority** | P0 |
| **Area** | continuous-run / infra |
| **Effort** | M (~1 session) |
| **Benefit** | High — stable boot under redeploy/crash loops |
| **Implementation risk** | Med — over-gating leaves stale data |
| **Created** | 2026-07-10 |
| **Source** | bugs audit |

## Resolution

Confirmed the boot sequence queried the full `fmp_fundamentals` table (~257 tickers) on every start with no cap. Implemented the recommended fix: new `lib/startup-refresh.ts` with `runStartupStaleRefresh()` — universe resolved from `ticker_registry` where `fetchFundamentals=true AND isActive=true` (falls back to the `WATCHLIST` constant on an empty registry), capped at `STARTUP_REFRESH_CAP` (default 25), gated by the existing FMP budget check, with a `SKIP_STARTUP_REFRESH=true` escape hatch. `index.ts` now calls this helper instead of running the old full-universe query.

Verified live across 3 restarts: boot logs now show a registry-scoped count instead of the full ~257, so a crash loop costs at most `cap` vendor calls per boot. Full test suite and typecheck clean (2 pre-existing unrelated errors, unaffected).
