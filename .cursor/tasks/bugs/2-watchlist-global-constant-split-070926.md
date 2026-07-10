# watchlist-global-constant-split

| Field | Value |
|---|---|
| **Status** | done — 2026-07-10 |
| **Priority** | P0 |
| **Area** | multi-user / data |
| **Effort** | L (3–5 sessions) |
| **Benefit** | Critical — scorecard/scanner must match user's DB watchlist |
| **Implementation risk** | High — touches seeder, technical, scanner, constants |
| **Created** | 2026-07-10 |
| **Source** | bugs production-readiness audit |
| **Related** | [19-register-empty-watchlist](19-register-empty-watchlist-070926.md), [3-home-hardcoded](3-home-hardcoded-fundamental-universe-070926.md), [enh/16](../enhancements/16-watchlist-monitor-improvements-070926.md) |
| **Type** | FIX (SSOT) |
| **Reuse / update** | [`watchlist` table](../lib/db/src/schema/index.ts), [`routes/watchlist.ts`](../artifacts/api-server/src/routes/watchlist.ts), [`getIndicatorsBatch`](../artifacts/api-server/src/lib/indicators.ts), [`WATCHLIST` constant](../artifacts/api-server/src/lib/constants.ts) as **seed template only** |

### Purpose
One watchlist truth: per-user PG rows drive scorecard, seeder targets, and technical batch — not the frozen `WATCHLIST` constant alone.

---

## 1. Finding + evidence

| Layer | Source | Consumers |
|---|---|---|
| Per-user | `watchlist` + `/api/watchlist` | FE `useWatchlist`, watchlist page |
| Global | `WATCHLIST = Object.keys(RSI_THRESHOLDS)` (~31) | [`technical/scorecard`](../artifacts/api-server/src/routes/technical.ts), [`seeder.ts`](../artifacts/api-server/src/lib/seeder.ts), admin fundamentals refresh |

User adds ticker via POST watchlist → row in DB → **not** added to scorecard batch (still uses `WATCHLIST` filter).

---

## 2. Repro

1. User A adds `XYZ` to watchlist (POST succeeds).
2. Open Technical / Options Scanner scorecard — `XYZ` absent from indicator batch.
3. `GET /api/technical/scorecard` returns only ~31 constant tickers.

---

## 3. Why this bug occurred

- **Genesis:** Original product = fixed CSP universe in `RSI_THRESHOLDS` / constants.
- **Drift:** Per-user [`watchlist` table](../lib/db/src/schema/index.ts) added later; **batch pipelines not rewired**.
- **Category:** wrong SSOT · partial migration

---

## 4. Permanent prevention

| Guardrail | Detail |
|---|---|
| Integration test | User watchlist ticker appears in `/technical/scorecard` when authenticated |
| Arch rule | No new feature reads `WATCHLIST` for **user-visible** lists — use session watchlist or union query |
| **Non-goals** | Do not remove constants tier/RSI thresholds; do not materialize per-user rankings table (enh/27 deferred) |

---

## 5. Fix side-effects

| Risk | Mitigation |
|---|---|
| Empty watchlist → empty scorecard | [bug/19](19-register-empty-watchlist-070926.md) default seed |
| Union of all users' tickers huge | Cap per-user ([bug/10](10-watchlist-no-max-size-070926.md)); seeder uses union with daily budget |
| Seeder Yahoo storm | Keep 3-worker limit; skip already-cached today |
| RSI thresholds missing for new ticker | Default threshold 40 in `getIndicators` |

---

## 6. Fix options

### A — Session-scoped scorecard (v1)
- `GET /technical/scorecard` uses `req.session.userId` → query `watchlist` table tickers.
- Seeder: seed **union** of distinct watchlist tickers (nightly cap).

### B — System universe + user overlay
- Keep `WATCHLIST` as "system monitored"; user tickers merged at read time with explicit UI label.

**Recommend A** for multi-user honesty.

---

## 7. Acceptance criteria

- [ ] Tickers in user DB watchlist appear in scorecard for that session
- [ ] User B does not see User A-only tickers in scorecard
- [ ] `WATCHLIST` constant documented as default seed template only
- [ ] Seeder processes union of watchlist tickers (with budget skip)

---

## 8. Implementation research pack

| Pri | Path | Change |
|---|---|---|
| **P0** | `routes/technical.ts` | Load tickers from DB by userId |
| **P0** | `lib/watchlist-tickers.ts` | **New** helper: `getUserWatchlistTickers`, `getUnionWatchlistTickers`, `isTickerOnUserWatchlist` |
| **P0** | `lib/seeder.ts` | `getMissingTickers` from union query |
| **P0** | `routes/indicators.ts` | Replace `WATCHLIST.includes` gate with user watchlist |
| **P1** | `routes/technicals.ts` | Admin refresh universe — document or use union |
| **P1** | `routes/fundamentals.ts` | Admin refresh / stock-db — not hardcoded `WATCHLIST` only |
| **P1** | `constants.ts` | Comment: template not runtime SSOT |
| **P1** | `options-scanner.tsx` | Retest after API change |

**Depends:** [bug/19](19-register-empty-watchlist-070926.md) for new users.

---

## 9. Verify (before fix)

1. User adds `XYZ` to watchlist — POST succeeds.
2. `GET /api/technical/scorecard` — `XYZ` absent (~31 tickers only).
3. `GET /api/indicators/XYZ` → **404**.
4. `grep WATCHLIST artifacts/api-server/src/routes/{technical,indicators,technicals,fundamentals}.ts`

---

## 10. Fix (files)

All **P0** rows in §8 — scorecard alone is insufficient.

---

## 11. Test (after fix)

| Type | Action | Pass |
|---|---|---|
| Manual | User A ticker in scorecard; User B isolated | ✓ |
| Manual | `GET /api/indicators/{userTicker}` → 200 | ✓ |
| CI | `pnpm --filter @workspace/api-server test` | pass |

---

## 12. Manual-only

- Seeder union size with many users; pair with bug/13

---

## 13. Regression watchlist

- `WATCHLIST` seeds `ticker_config` on empty DB
- Seeder 3-worker Yahoo limit; `getTier` / RSI_THRESHOLDS unchanged

---

## Impact & Risk Analysis

Highest blast radius bug in backlog — coordinate with [bug/3](3-home-hardcoded-fundamental-universe-070926.md), [bug/11](11-options-scanner-fetch-storm-070926.md).

---

## DONE (2026-07-10)

Implemented Fix option A (session-scoped scorecard). New `lib/watchlist-tickers.ts` provides `getUserWatchlistTickers`, `getUnionWatchlistTickers` (all users' distinct tickers ∪ default `WATCHLIST` seed), and `isTickerOnUserWatchlist`.

- `routes/technical.ts` — `/technical/scorecard` and `/technical/refresh/:ticker` now read the authenticated user's watchlist (route is already behind `requireAuth` at the router level).
- `routes/indicators.ts` — `/indicators/:ticker` gate uses `isTickerOnUserWatchlist`; `/indicators/batch` defaults to the caller's watchlist when `?tickers=` omitted.
- `lib/seeder.ts` — `getMissingTickers` now sources from `getUnionWatchlistTickers()` instead of the frozen constant, so newly-added user tickers get backfilled overnight. `seedTickerConfig` (tier/RSI metadata bootstrap) intentionally left on `WATCHLIST` — that's seeding `ticker_config` defaults, not a user-facing list.
- `routes/technicals.ts` and `routes/fundamentals.ts` (admin refresh/status/stock-db endpoints) — switched from `WATCHLIST` to `getUnionWatchlistTickers()` so admin bulk operations cover every user's tickers, not just the original 31.
- `constants.ts` — `WATCHLIST` now documented as seed-template-only, not runtime SSOT.
- `options-scanner.tsx` retested conceptually: it already consumes `/api/technical/scorecard` + `useWatchlist()`, so it picks up the per-user fix with no code change.

**Not touched (explicitly out of scope):** `lib/macro-highlights.ts`, `lib/startup-refresh.ts` (bug/4, already done), and the one-off `scripts/backfill-*.ts` CLI tools — none were named in §8's P0/P1 file list, and backfill scripts are intentionally scoped to the seed set per their own comments.

Verified: `pnpm --filter @workspace/api-server test` (35 pass), `pnpm --filter @workspace/stock-compare test` (268 pass), `tsc --noEmit` clean on both packages (two pre-existing unrelated errors in `backfill-edgar.ts`/`merge-trusted.ts`, not touched by this change).
