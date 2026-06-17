# FILDI Phase 2 — API Routes Report
**Date:** 2026-06-17  
**Feature:** Social / Trade Ideas (FILDI)  
**Phase:** 2 of N — API Routes

## What was done

Created `artifacts/api-server/src/routes/feed.ts` and mounted it at `/api/feed/*` in `routes/index.ts`.

## Routes implemented

| Method | Path | Auth | Notes |
|--------|------|------|-------|
| POST | /api/feed/posts | requireAuth | Create post; tradeType hardcoded SELL_PUT; rate-limit 3 open max |
| GET | /api/feed/posts | requireAuth | List with likeCount, commentCount, likedByMe; filters: ticker, username, status, sort, limit, offset |
| GET | /api/feed/posts/:id | requireAuth | Single post + comments array |
| PATCH | /api/feed/posts/:id/close | requireAuth (owner) | Closes post, computes resolvedPnl = (premiumPerContract - closePremium) × contracts × 100 |
| DELETE | /api/feed/posts/:id | requireAuth (owner or admin) | Only OPEN posts |
| POST | /api/feed/posts/:id/like | requireAuth | ON CONFLICT DO NOTHING (idempotent) |
| DELETE | /api/feed/posts/:id/like | requireAuth | Returns updated likeCount |
| POST | /api/feed/posts/:id/comments | requireAuth | Max 500 chars, returns username/avatarUrl |
| DELETE | /api/feed/comments/:id | requireAuth (owner or admin) | Hard delete |
| GET | /api/feed/profile/:username | requireAuth | User + stats (wins/losses/winRate/totalPnl) + posts |

## Manual test matrix results

| # | Test | Result |
|---|------|--------|
| 1 | POST valid post | ✅ 201, numeric fields parsed |
| 2 | POST 4th post | ✅ 429 `Max 3 open trade ideas at a time` |
| 3 | GET /posts → likeCount, commentCount, likedByMe | ✅ all fields present |
| 4 | GET /posts?ticker=NVDA | ✅ filtered to 1 result |
| 5 | GET /posts?username=jamie | ✅ filtered to 3 results |
| 6 | POST like → increments | ✅ likeCount:1, likedByMe:true |
| 7 | POST like again → idempotent | ✅ likeCount:1 (no duplicate) |
| 8 | DELETE like → decrements | ✅ likeCount:1 (testuser still liked), likedByMe:false |
| 9 | POST comment → 201 with username | ✅ username/avatarUrl included |
| 10 | PATCH /close → CLOSED, resolvedPnl=(1.50-0.50)×2×100=200 | ✅ status=CLOSED, resolvedPnl=200 |
| 11 | PATCH /close on closed post → 400 | ✅ `Post is not OPEN` |
| 12 | GET /profile/jamie → stats | ✅ wins:1, losses:0, closed:1, winRate:1, totalPnl:200 |

## Verification
- `tsc --noEmit`: 0 errors
- No test suite in repo
- All 12 manual tests passed

## Next
Phase 3 (awaiting approval) — React UI components for the feed page.
