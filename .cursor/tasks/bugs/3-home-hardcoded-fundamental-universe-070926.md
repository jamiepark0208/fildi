# home-hardcoded-fundamental-universe

| Field | Value |
|---|---|
| **Status** | ready |
| **Priority** | P1 |
| **Area** | ui / multi-user |
| **Effort** | S (~half day) |
| **Benefit** | High — home rankings match user's watchlist |
| **Implementation risk** | Low |
| **Created** | 2026-07-10 |
| **Source** | bugs audit |
| **Related** | [2-watchlist-global-constant-split](2-watchlist-global-constant-split-070926.md), [new_app_features/4](../new_app_features/4-home-dashboard-redesign-070926.md) (**conflict:** seq 4 says keep hardcode for BUG-01 — rescope after this fix) |
| **Reuse / update** | [`useWatchlist()`](../artifacts/stock-compare/src/hooks/use-watchlist.ts), [`/fundamentals/rankings`](../artifacts/api-server/src/routes/fundamentals.ts), [`/fundamentals/peer-groups`](../artifacts/api-server/src/routes/fundamentals.ts) |

### Purpose
Remove frozen `FUNDAMENTAL_WATCHLIST` from home; derive peer norm universe from user's DB watchlist.

---

## 1. Finding + evidence

[`home.tsx` L16–20](../artifacts/stock-compare/src/pages/home.tsx): hardcoded 31 tickers for peer-groups query despite comment "BUG-01 fix" and server-driven rankings at L107–115.

Rankings API returns **all** DB tickers — home filters mentally against hardcoded list.

---

## 2. Repro

1. User adds ticker not in hardcoded list to watchlist.
2. Home leaderboard / peer norm may exclude or mis-rank vs user's actual shelf.

---

## 3. Why this bug occurred

- **Genesis:** BUG-01 required stable peer universe for `computeRankingsV2` when client-side.
- **Drift:** Rankings moved server-side + user watchlist DB; hardcode never removed.
- **Category:** stale workaround · wrong SSOT

---

## 4. Permanent prevention

- Home uses `useWatchlist().tickers` for peer-groups query — single source.
- **Non-goals:** Do not reintroduce client `computeRankingsV2` full universe ([enh/27](../enhancements/27-precomputed-rankings-materialization-070926.md) deferred).
- Update [new_app_features/4](../new_app_features/4-home-dashboard-redesign-070926.md) out-of-scope note when building Today shell.

---

## 5. Fix side-effects

| Risk | Mitigation |
|---|---|
| Empty watchlist → broken home | Depends [bug/19](19-register-empty-watchlist-070926.md); show empty state |
| Single-ticker watchlist peer norm weak | Document min 2 tickers for leaderboard; UI copy |
| new_app_features/4 assumed hardcode | Rescope seq 4 W7 |

---

## 6. Fix options

**A:** Replace `FUNDAMENTAL_WATCHLIST` with `useWatchlist().tickers` in peer-groups + filter rankings client-side to that set.

**B:** New `GET /fundamentals/rankings?tickers=` server filter (less client logic).

---

## 7. Acceptance criteria

- [ ] No `FUNDAMENTAL_WATCHLIST` constant in home.tsx
- [ ] Peer-groups query uses user's watchlist tickers
- [ ] Rankings display only user's tickers (or documented server filter)

---

## 8. Implementation research pack

| Pri | Path | Change |
|---|---|---|
| **P0** | `artifacts/stock-compare/src/pages/home.tsx` | useWatchlist-driven universe |
| **P1** | `new_app_features/4-*.md` | Note BUG-01 resolved via user watchlist |

**Depends:** [bug/2](2-watchlist-global-constant-split-070926.md) for scorecard parity (parallel OK).

---

## 9. Verify (before fix)

```bash
grep -n FUNDAMENTAL_WATCHLIST artifacts/stock-compare/src/pages/home.tsx
# L16–20: hardcoded ~31 tickers
```

1. Add ticker not in hardcoded list to watchlist.
2. Home peer-groups / leaderboard omits or mis-ranks it.

---

## 10. Fix (files)

| Order | Path | Change |
|---|---|---|
| 1 | `artifacts/stock-compare/src/pages/home.tsx` | Replace `FUNDAMENTAL_WATCHLIST` with `useWatchlist().tickers` for peer-groups query; filter rankings display |
| 2 | `new_app_features/4-home-dashboard-redesign-070926.md` | Rescope BUG-01 note |

Optional **B:** `GET /fundamentals/rankings?tickers=` server filter — only if client filter insufficient.

---

## 11. Test (after fix)

| Type | Action | Pass |
|---|---|---|
| Manual | No `FUNDAMENTAL_WATCHLIST` in home.tsx | ✓ |
| Manual | Peer-groups request uses user's watchlist tickers | ✓ |
| Manual | Empty watchlist → empty state (needs bug/19 seed for new users) | ✓ |
| CI | `pnpm --filter @workspace/stock-compare typecheck` | pass |

---

## 12. Manual-only

- Leaderboard with single-ticker watchlist (weak peer norm) — UI copy

---

## 13. Regression watchlist

- `GET /api/fundamentals/rankings` still returns full DB (client filter only in option A)
- Do not reintroduce client `computeRankingsV2` full universe
