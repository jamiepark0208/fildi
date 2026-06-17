# FILDI Phase 1 — DB Schema Report
**Date:** 2026-06-17  
**Feature:** Social / Trade Ideas (FILDI)  
**Phase:** 1 of N — Database Schema

## What was done

Added 3 new tables to `lib/db/src/schema/index.ts` and pushed to production DB via `drizzle-kit push`.

### Tables created

**`trade_posts`** — core social post entity  
- 21 columns: id, userId (FK→users cascade), ticker, tradeType (default SELL_PUT), strike, expiry, contracts (default 1), premiumPerContract, confidence, notes, ivRankAtEntry, techScoreAtEntry, regimeAtEntry, vixAtEntry, signalAtEntry, status (default OPEN), closePremium, resolvedAt, resolvedPnl, createdAt, updatedAt

**`likes`** — post reactions with dedup constraint  
- Unique constraint on (postId, userId) — prevents double-likes
- FK → trade_posts (cascade), FK → users (cascade)

**`comments`** — threaded post responses  
- FK → trade_posts (cascade), FK → users (cascade)

### Schema exports added
- `tradePosts`, `InsertTradePost`, `TradePost`
- `likes`, `InsertLike`, `Like`
- `comments`, `InsertComment`, `Comment`
- `unique` added to drizzle-orm/pg-core imports

## Verification
- `tsc --noEmit`: 0 errors
- `drizzle-kit push`: applied cleanly
- DB confirmed: `trade_posts`, `likes`, `comments` all present in `pg_tables`
- No existing test suite in repo

## Next
Phase 2 (awaiting approval) — API routes for creating/fetching trade posts, toggling likes, and adding comments.
